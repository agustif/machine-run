import { isNotFound, MachinePaths, Platform, Windows } from "@machine-run/core";
import { type Drift, type DriftField, type Reconciler, toProvider } from "@machine-run/engine";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Boolean from "effect/Boolean";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { PlatformError } from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import { SecretSource, type SecretError } from "./Backend.ts";
import { readSecret } from "./Store.ts";
import * as Schema from "effect/Schema";
import * as UndefinedOr from "effect/UndefinedOr";

/** What the file's final byte should be. */
export const TrailingNewline = Schema.Literals(["preserve", "ensure", "strip"]);
export type TrailingNewline = typeof TrailingNewline.Type;

export const SecretFileProps = Schema.Struct({
  /** Path to write the secret to, e.g. `~/.ssh/id_ed25519_personal`. */
  path: Schema.String,
  /**
   * Which secret store to read from, and the backend-specific reference
   * within it — see {@link SecretSource}'s doc comment for each variant's
   * exact fields, e.g. `{ _tag: "OnePassword", vault: "Personal", item:
   * "GitHub SSH Key", field: "private key" }`.
   */
  source: SecretSource,
  /** POSIX file mode. @default 0o600 */
  mode: Schema.optionalKey(Schema.Number),
  /** POSIX mode for directories created to hold it. @default 0o700 */
  directoryMode: Schema.optionalKey(Schema.Number),
  /**
   * Explicit because it is per-secret and getting it wrong fails silently.
   * OpenSSH rejects a private key that does not end in a newline ("invalid
   * format"), while a token file carrying a stray newline breaks any consumer
   * doing an exact comparison. No single default is correct for both.
   *
   * @default "preserve" — write exactly the bytes the backend returned.
   */
  trailingNewline: Schema.optionalKey(TrailingNewline),
});

export type SecretFileProps = typeof SecretFileProps.Type;

/**
 * State carries the path and the file's permissions — never the secret's
 * bytes, nor a hash of them.
 *
 * Alchemy persists props *and* attributes, and `localState()` is unencrypted
 * JSON, so nothing secret-derived may enter either. `source` is a prop and
 * *is* persisted — a tagged struct round-trips through JSON the same as any
 * other prop — which is correct: a pointer to a secret is not a secret.
 *
 * The consequence is worth stating plainly. Rotation in the store is
 * undetectable: changing `source` is caught because it is a prop, but a new
 * value behind an unchanged `source` is not. The alternatives are both worse
 * — record a hash of the secret, which is forbidden, or fetch every secret on
 * every plan, which turns a read-only preview into an operation that touches
 * the vault and can prompt for biometrics. Deleting the file forces a
 * re-fetch.
 */
export const SecretFileState = Schema.Struct({
  path: Schema.String,
  mode: Schema.Number,
  /** `icacls <path>`'s listing, on Windows only — see `Machine.Directory`. */
  acl: Schema.optionalKey(Schema.String),
  /**
   * Whether the apply that produced this state *created* the file, as opposed to
   * overwriting something already there.
   *
   * This is the marker `unapply` needs and used to lack. `apply` receives the live
   * state as `observed`, and `Option.none()` means nothing was at the path — so
   * "we made this file" is knowable at write time rather than guessable at destroy
   * time. Absent only on state written before this field existed, which `unapply`
   * treats as "cannot tell" and leaves alone.
   */
  created: Schema.optionalKey(Schema.Boolean),
});

export type SecretFileState = typeof SecretFileState.Type;

export interface SecretFile extends Resource<
  "Machine.SecretFile",
  SecretFileProps,
  SecretFileState
> {}

export const SecretFile = Resource<SecretFile>("Machine.SecretFile");

/**
 * Raised when the path cannot be inspected at all.
 *
 * Reading "unreadable" as "absent" is worse here than anywhere else: `apply`
 * would go on to fetch the secret from its store and write it to a path
 * nothing could see, so a permissions problem would be answered by moving
 * credential material rather than by reporting it.
 */
export class SecretFilePathUnreadable extends Data.TaggedError("SecretFilePathUnreadable")<{
  path: string;
  cause: PlatformError;
}> {
  override get message() {
    return `Could not inspect "${this.path}": ${this.cause.reason._tag}.`;
  }
}

const DEFAULT_MODE = 0o600;
const DEFAULT_DIRECTORY_MODE = 0o700;

/** `0o600`-style rendering for a `DriftField`, matching this file's own doc comments. */
const octal = (mode: number): string => `0o${mode.toString(8).padStart(3, "0")}`;

/**
 * `strip` removes `\r` as well as `\n`, because a secret that arrived from a
 * vault over a CRLF-normalising transport would otherwise keep a dangling
 * carriage return — which defeats the entire reason a caller asks for `strip`:
 * a token compared byte-for-byte by its consumer.
 *
 * `ensure` deliberately appends only `\n`. The file it produces is read by
 * OpenSSH and similar tools, which want exactly one LF; matching the host's
 * convention would be actively wrong here.
 */
const applyNewline = (value: string, policy: TrailingNewline | undefined): string => {
  if (policy === "ensure") return value.endsWith("\n") ? value : `${value}\n`;
  if (policy === "strip") return value.replace(/[\r\n]+$/, "");
  return value;
};

/**
 * Whether observed permissions satisfy the desired mode — mode bits on POSIX,
 * the live ACL on Windows, where there is no mode to compare. An unreadable ACL
 * is never satisfied: "cannot confirm" converges by re-applying. See
 * `Machine.Directory` for the full reasoning.
 */
const modeSatisfied = (
  platform: typeof Platform.Service,
  observed: { readonly path: string; readonly mode?: number; readonly acl?: string },
  desiredMode: number | undefined,
): boolean => {
  if (desiredMode === undefined) return true;
  if (!platform.isWindows) return observed.mode === desiredMode;
  return Windows.aclSatisfiesMode(
    UndefinedOr.match(observed.acl, {
      onUndefined: () => Option.none<string>(),
      onDefined: (acl) => Option.some(acl),
    }),
    observed.path,
    desiredMode,
    "file",
  );
};

export const makeSecretFileReconciler: Effect.Effect<
  Reconciler<
    SecretFileProps,
    SecretFileState,
    PlatformError | SecretError | SecretFilePathUnreadable
  >,
  never,
  FileSystem.FileSystem | Path.Path | MachinePaths | Platform
> = Effect.gen(function* () {
  const platform = yield* Platform;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* MachinePaths;

  return {
    address: (props) => paths.expand(props.path),
    // A path a recipe adopts may already hold a hand-placed key or token, and
    // overwriting one with no copy is unrecoverable. The engine decides when:
    // a resource's first apply, and the first apply after adopting something
    // already present.
    snapshotBeforeApply: true,
    // A secret file is precisely the hand-placed content worth refusing rather
    // than silently taking over — an operator's own key at this path is not ours
    // to overwrite without being told. Same reasoning as `Machine.File`.
    refuseUnowned: true,

    // Presence and permissions only. Reading the file back to compare content
    // would mean holding a secret in memory during planning for no decision it
    // can inform, since the store — not the file — is the source of truth.
    observe: (props, ctx) =>
      Effect.gen(function* () {
        const target = paths.expand(props.path);
        const info = yield* fs
          .stat(target)
          .pipe(
            Effect.catchTag("PlatformError", (cause) =>
              isNotFound(cause)
                ? Effect.succeed(undefined)
                : Effect.fail(new SecretFilePathUnreadable({ path: target, cause })),
            ),
          );
        if (info === undefined) return Option.none();
        const acl = yield* Boolean.match(platform.isWindows, {
          onFalse: () => Effect.succeed(Option.none<string>()),
          onTrue: () => Windows.readAcl(ctx.exec, target),
        });
        return Option.some({
          path: target,
          mode: Number(info.mode) & 0o777,
          ...Option.match(acl, { onNone: () => ({}), onSome: (value) => ({ acl: value }) }),
        });
      }),

    desired: (props) =>
      Effect.succeed({
        path: paths.expand(props.path),
        mode: props.mode ?? DEFAULT_MODE,
      }),

    matches: (observed, desired) =>
      observed.path === desired.path && modeSatisfied(platform, observed, desired.mode),

    // Only `path`/`mode` — the same two fields `matches` compares, and the
    // only two `SecretFileState` carries. Never add a field derived from the
    // secret's bytes: a `DriftField` ends up in plan output, and this state
    // is deliberately blind to the value already (see `SecretFileState`'s
    // doc comment) — a rotated secret behind an unchanged `path`/`mode`
    // stays undetectable here too, for the same reason.
    drift: (observed, desired): Drift => {
      const fields: DriftField[] = [];
      if (observed.path !== desired.path) {
        fields.push({ field: "path", observed: observed.path, desired: desired.path });
      }
      if (observed.mode !== desired.mode) {
        fields.push({
          field: "mode",
          observed: octal(observed.mode),
          desired: octal(desired.mode),
          direction: observed.mode < desired.mode ? "behind" : "ahead",
        });
      }
      return fields;
    },

    apply: ({ props, observed, desired }, ctx) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(desired.path), {
          recursive: true,
          mode: props.directoryMode ?? DEFAULT_DIRECTORY_MODE,
        });

        const secret = yield* readSecret(props.source, ctx.exec);
        const content = applyNewline(Redacted.value(secret), props.trailingNewline);

        // Created with the restrictive mode rather than chmod'd afterwards, so
        // the file is never briefly readable at the process umask between
        // being written and being restricted. The chmod still follows, because
        // the OS only applies `mode` when the file is created — an existing
        // file keeps whatever bits it already had.
        yield* fs.writeFileString(desired.path, content, { mode: desired.mode });
        // On Windows `chmod` only toggles the read-only bit, so the mode has to
        // be expressed as an ACL or a secret file's 0600 intent is never actually
        // established and `matches` reports drift forever.
        yield* Boolean.match(platform.isWindows, {
          onFalse: () => fs.chmod(desired.path, desired.mode),
          onTrue: () =>
            Windows.applyMode(ctx.exec, desired.path, desired.mode, "file").pipe(
              Effect.orElseSucceed(() => undefined),
            ),
        });

        return { ...desired, created: Option.isNone(observed) };
      }),

    /**
     * Removes the file, but only one this resource created.
     *
     * The distinction is the whole thing. Deleting a file we wrote is a safe undo:
     * the secret still lives in its store and is refetchable. Deleting one we
     * merely overwrote — an operator's own key, adopted with `--adopt` — is an
     * unrecoverable loss of credential material. `apply` records which case it
     * was, from `observed`, so this does not have to guess.
     *
     * `created: false` and a missing `created` both leave the file alone. The
     * second is state written before that field existed, where "cannot tell" and
     * "was not ours" deserve the same caution.
     */
    unapply: ({ recorded }) =>
      UndefinedOr.match(recorded.created, {
        onUndefined: () => Effect.void,
        onDefined: (created) =>
          Boolean.match(created, {
            onFalse: () => Effect.void,
            onTrue: () => fs.remove(recorded.path).pipe(Effect.orElseSucceed(() => undefined)),
          }),
      }),
  };
});

export const SecretFileProvider = () => toProvider(SecretFile, makeSecretFileReconciler);
