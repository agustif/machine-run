import { isNotFound, MachinePaths } from "@machine-run/core";
import { type Reconciler, toProvider } from "@machine-run/engine";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { PlatformError } from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import { SecretSource, type SecretError } from "./Backend.ts";
import { readSecret } from "./Store.ts";
import * as Schema from "effect/Schema";

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

const applyNewline = (value: string, policy: TrailingNewline | undefined): string => {
  if (policy === "ensure") return value.endsWith("\n") ? value : `${value}\n`;
  if (policy === "strip") return value.replace(/\n+$/, "");
  return value;
};

export const makeSecretFileReconciler: Effect.Effect<
  Reconciler<
    SecretFileProps,
    SecretFileState,
    PlatformError | SecretError | SecretFilePathUnreadable
  >,
  never,
  FileSystem.FileSystem | Path.Path | MachinePaths
> = Effect.gen(function* () {
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

    // Presence and permissions only. Reading the file back to compare content
    // would mean holding a secret in memory during planning for no decision it
    // can inform, since the store — not the file — is the source of truth.
    observe: (props) =>
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
        if (info === undefined) return undefined;
        return { path: target, mode: Number(info.mode) & 0o777 };
      }),

    desired: (props) =>
      Effect.succeed({
        path: paths.expand(props.path),
        mode: props.mode ?? DEFAULT_MODE,
      }),

    matches: (observed, desired) =>
      observed.path === desired.path && observed.mode === desired.mode,

    apply: ({ props, desired }, ctx) =>
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
        yield* fs.chmod(desired.path, desired.mode);

        return desired;
      }),
  };
});

export const SecretFileProvider = () => toProvider(SecretFile, makeSecretFileReconciler);
