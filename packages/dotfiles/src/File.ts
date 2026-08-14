import { MachinePaths, Platform, Windows, isNotFound, makeSha256, readIfPresent } from "@machine-run/core";
import { type Drift, type DriftField, type Reconciler, toProvider } from "@machine-run/engine";
import { Resource } from "alchemy/Resource";
import * as Boolean from "effect/Boolean";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Crypto from "effect/Crypto";
import * as Path from "effect/Path";
import * as UndefinedOr from "effect/UndefinedOr";
import * as Schema from "effect/Schema";
import { PlatformError } from "effect/PlatformError";

/**
 * A file this tool fully owns: its entire content is generated, and anything
 * else written there is replaced on the next apply.
 *
 * Use it for files nothing else edits by hand — a generated persona config, a
 * generated Brewfile, a tool's own `config.toml`. For a file that carries
 * substantial hand-written content alongside a generated region — `~/.zshrc`,
 * `~/.gitconfig`, `~/.ssh/config` — use {@link ManagedBlock}, which only ever
 * rewrites the region between its markers.
 *
 * `content` is a prop, and Alchemy persists props into its state store, which
 * `Alchemy.localState()` keeps as unencrypted JSON. Anything credential-shaped
 * belongs in `Machine.SecretFile` from `@machine-run/secrets`, whose value
 * never enters state.
 */
export const FileProps = Schema.Struct({
  /** Path to the file. `~` is expanded. */
  path: Schema.String,
  /** Full desired content. */
  content: Schema.String,
  /** POSIX file mode, e.g. `0o600`. Left alone when unset. */
  mode: Schema.optionalKey(Schema.Number),
  /** POSIX mode for directories created to hold this file, e.g. `0o700`. */
  directoryMode: Schema.optionalKey(Schema.Number),
});

export type FileProps = typeof FileProps.Type;

/**
 * `hash` is of the file's content, so a file edited by anything else stops
 * matching and is rewritten. `mode` takes part in the comparison rather than
 * being write-only, and is absent when the recipe does not constrain it.
 *
 * `backupPath` is never part of desired state or of the observe/matches
 * comparison — it is bookkeeping `apply` writes for `unapply` to read back
 * from `recorded` later.
 */
export const FileState = Schema.Struct({
  path: Schema.String,
  hash: Schema.String,
  mode: Schema.optionalKey(Schema.Number),
  /** `icacls <path>`'s listing, on Windows only — see `Machine.Directory`. */
  acl: Schema.optionalKey(Schema.String),
  backupPath: Schema.optionalKey(Schema.String),
});

export type FileState = typeof FileState.Type;

export interface File extends Resource<"Machine.File", FileProps, FileState> {}

export const File = Resource<File>("Machine.File");

/**
 * Raised when the path cannot be inspected at all — an unreadable parent
 * directory, a permissions problem, an I/O error.
 *
 * Distinct from "there is no file here", which is an ordinary state to
 * converge from. Collapsing the two would make an unreadable path read as
 * absent, so `apply` would overwrite something it could not see, and the
 * error the operator actually needs would be replaced by whatever the write
 * failed with.
 */
export class FilePathUnreadable extends Data.TaggedError("FilePathUnreadable")<{
  path: string;
  cause: PlatformError;
}> {
  override get message() {
    return `Could not inspect "${this.path}": ${this.cause.reason._tag}.`;
  }
}

/**
 * Whether an observed file's permissions satisfy the desired mode — mode bits on
 * POSIX, the live ACL on Windows, where there is no mode to compare. See
 * `Machine.Directory` for the full reasoning; an unreadable ACL is never
 * satisfied.
 */
const modeSatisfied = (
  platform: typeof Platform.Service,
  observed: FileState,
  desired: FileState,
): boolean => {
  if (desired.mode === undefined) return true;
  if (!platform.isWindows) return observed.mode === desired.mode;
  return Windows.aclSatisfiesMode(
    UndefinedOr.match(observed.acl, {
      onUndefined: () => Option.none<string>(),
      onDefined: (acl) => Option.some(acl),
    }),
    observed.path,
    desired.mode,
    "file",
  );
};

export const makeFileReconciler: Effect.Effect<
  Reconciler<FileProps, FileState, PlatformError | FilePathUnreadable>,
  never,
  FileSystem.FileSystem | Path.Path | MachinePaths | Crypto.Crypto | Platform
> = Effect.gen(function* () {
  const platform = yield* Platform;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* MachinePaths;
  const sha256 = yield* makeSha256;

  return {
    address: (props) => paths.expand(props.path),
    snapshotBeforeApply: true,

    observe: (props, ctx) =>
      Effect.gen(function* () {
        const target = paths.expand(props.path);
        const info = yield* fs
          .stat(target)
          .pipe(
            Effect.catchTag("PlatformError", (cause) =>
              isNotFound(cause)
                ? Effect.succeed(undefined)
                : Effect.fail(new FilePathUnreadable({ path: target, cause })),
            ),
          );
        if (info === undefined) return Option.none();
        // `stat` above already confirmed something is here, so a read
        // failure now is not "the file is empty" — it's a permission change
        // or an I/O error in the window between the two calls. Only a
        // genuine not-found (the file vanishing in that same window) is
        // truly absent; anything else is the same "cannot inspect" failure
        // `stat` raises above, applied to the read.
        // `stat` above already established the file exists, so the read
        // vanishing here means it was removed in the window between the two.
        // Treating that as empty content is the same answer `stat` would have
        // given a moment earlier.
        const content = Option.getOrElse(
          yield* readIfPresent(
            fs,
            target,
            (cause) => new FilePathUnreadable({ path: target, cause }),
          ),
          () => "",
        );
        const acl = yield* Boolean.match(platform.isWindows, {
          onFalse: () => Effect.succeed(Option.none<string>()),
          onTrue: () => Windows.readAcl(ctx.exec, target),
        });
        return Option.some({
          path: target,
          hash: yield* sha256(content),
          mode: Number(info.mode) & 0o777,
          ...Option.match(acl, { onNone: () => ({}), onSome: (value) => ({ acl: value }) }),
        });
      }),

    desired: (props) =>
      Effect.gen(function* () {
        return {
          path: paths.expand(props.path),
          hash: yield* sha256(props.content),
          ...(props.mode !== undefined ? { mode: props.mode } : {}),
        };
      }),

    matches: (observed, desired) =>
      observed.path === desired.path &&
      observed.hash === desired.hash &&
      modeSatisfied(platform, observed, desired),

    drift: (observed, desired): Drift => {
      const fields: DriftField[] = [];
      if (observed.path !== desired.path) {
        fields.push({ field: "path", observed: observed.path, desired: desired.path });
      }
      if (observed.hash !== desired.hash) {
        // A hash is unordered and unreadable in full — a short prefix is
        // enough to show a reader "this changed" in plan output.
        fields.push({
          field: "content",
          observed: observed.hash.slice(0, 12),
          desired: desired.hash.slice(0, 12),
        });
      }
      if (desired.mode !== undefined && observed.mode !== desired.mode) {
        const desiredMode = desired.mode;
        // `observed.mode` can genuinely be absent (an unconstrained recipe's
        // recorded state, or a hand-built test fixture) — that is not a value
        // to order against, so `direction` is only set when there is a real
        // number on both sides.
        const modeField: DriftField =
          observed.mode === undefined
            ? { field: "mode", observed: "unset", desired: desiredMode.toString(8) }
            : {
                field: "mode",
                observed: observed.mode.toString(8),
                desired: desiredMode.toString(8),
                direction: observed.mode < desiredMode ? "behind" : "ahead",
              };
        fields.push(modeField);
      }
      return fields;
    },

    apply: ({ props, desired, snapshot }, ctx) =>
      Effect.gen(function* () {
        const target = desired.path;
        yield* fs.makeDirectory(path.dirname(target), {
          recursive: true,
          ...(props.directoryMode !== undefined ? { mode: props.directoryMode } : {}),
        });
        // The engine's snapshot, folded into this resource's own `State` so a
        // later `unapply` can restore rather than merely remove — the backup
        // directory is stamped fresh per run, so only persisted state carries a
        // path that far. Taken from the input rather than by calling
        // `ctx.snapshot` here: the engine archives only what this resource did
        // *not* write itself, and snapshotting on every apply would just
        // accumulate copies of our own previous output.
        const backupPath = snapshot;
        // `mode` is passed on the write *and* chmod'd after, because each
        // covers what the other cannot: the OS applies `mode` only when the
        // file is created (so an existing file would keep its old bits and
        // this reconciler would never converge), while chmod'ing alone would
        // leave a newly created file readable at the process umask for the
        // window between the two calls.
        yield* fs.writeFileString(target, props.content, { mode: props.mode });
        if (props.mode !== undefined) {
          yield* Boolean.match(platform.isWindows, {
            onFalse: () => fs.chmod(target, props.mode ?? 0),
            onTrue: () =>
              Windows.applyMode(ctx.exec, target, props.mode ?? 0, "file").pipe(
                Effect.orElseSucceed(() => undefined),
              ),
          });
        }
        const info = yield* fs.stat(target);
        return {
          ...desired,
          mode: Number(info.mode) & 0o777,
          ...(backupPath !== undefined ? { backupPath } : {}),
        };
      }),

    // Restores the content this apply overwrote, when a backup was captured;
    // otherwise removes the file this resource itself created. Never a
    // half-measure: whichever branch runs, the file ends up exactly where it
    // was before this resource ever touched it, or gone entirely.
    unapply: ({ observed, recorded }) =>
      Effect.gen(function* () {
        if (recorded.backupPath !== undefined) {
          const original = yield* fs.readFileString(recorded.backupPath);
          yield* fs.writeFileString(observed.path, original);
          return;
        }
        yield* fs.remove(observed.path);
      }),
  };
});

export const FileProvider = () => toProvider(File, makeFileReconciler);
