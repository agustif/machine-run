import { MachinePaths, isNotFound, makeSha256, readIfPresent } from "@machine-run/core";
import { type Reconciler, toProvider } from "@machine-run/engine";
import { Resource } from "alchemy/Resource";
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
 */
export const FileState = Schema.Struct({
  path: Schema.String,
  hash: Schema.String,
  mode: Schema.optionalKey(Schema.Number),
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

export const makeFileReconciler: Effect.Effect<
  Reconciler<FileProps, FileState, PlatformError | FilePathUnreadable>,
  never,
  FileSystem.FileSystem | Path.Path | MachinePaths | Crypto.Crypto
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* MachinePaths;
  const sha256 = yield* makeSha256;

  return {
    address: (props) => paths.expand(props.path),
    snapshotBeforeApply: true,

    observe: (props) =>
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
        return Option.some({
          path: target,
          hash: yield* sha256(content),
          mode: Number(info.mode) & 0o777,
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
      // An unset desired mode means the recipe does not constrain
      // permissions, so any observed mode satisfies it.
      UndefinedOr.match(desired.mode, {
        onUndefined: () => true,
        onDefined: (mode) => observed.mode === mode,
      }),

    apply: ({ props, desired }) =>
      Effect.gen(function* () {
        const target = desired.path;
        yield* fs.makeDirectory(path.dirname(target), {
          recursive: true,
          ...(props.directoryMode !== undefined ? { mode: props.directoryMode } : {}),
        });
        // `mode` is passed on the write *and* chmod'd after, because each
        // covers what the other cannot: the OS applies `mode` only when the
        // file is created (so an existing file would keep its old bits and
        // this reconciler would never converge), while chmod'ing alone would
        // leave a newly created file readable at the process umask for the
        // window between the two calls.
        yield* fs.writeFileString(target, props.content, { mode: props.mode });
        if (props.mode !== undefined) yield* fs.chmod(target, props.mode);
        const info = yield* fs.stat(target);
        return { ...desired, mode: Number(info.mode) & 0o777 };
      }),
  };
});

export const FileProvider = () => toProvider(File, makeFileReconciler);
