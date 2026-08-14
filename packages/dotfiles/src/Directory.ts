import { isNotFound, MachinePaths } from "@machine-run/core";
import { type Reconciler, toProvider } from "@machine-run/engine";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { type PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";

/**
 * Raised when something occupies {@link DirectoryProps.path} that is not a
 * directory — most commonly a file left over from before the path was put
 * under management.
 *
 * `apply` never deletes or replaces it: `fs.makeDirectory(..., { recursive:
 * true })` over an existing file fails with `ENOTDIR` on POSIX systems in any
 * case, and silently swapping a person's file for an empty directory because
 * a recipe asked for one is exactly the kind of destructive surprise this
 * tool avoids. Remove the file by hand once you've confirmed it's safe to
 * lose, then re-run.
 */
export class DirectoryPathIsFile extends Data.TaggedError("DirectoryPathIsFile")<{
  path: string;
}> {
  override get message() {
    return `"${this.path}" exists but is a file, not a directory. Machine.Directory will not delete or replace it — remove it by hand if a directory belongs there, then re-run.`;
  }
}

/**
 * Raised when {@link DirectoryProps.path} cannot be inspected at all — a
 * permissions problem on a parent directory, an I/O error — as distinct from
 * "nothing is there yet", which is an ordinary state to converge from.
 * Collapsing both into absence would make `apply` attempt creation over an
 * unreadable path and surface whatever error that attempt produced instead of
 * the one that actually explains the problem (mirrors `Symlink`'s
 * `SymlinkPathUnreadable`).
 */
export class DirectoryPathUnreadable extends Data.TaggedError("DirectoryPathUnreadable")<{
  path: string;
  cause: PlatformError;
}> {
  override get message() {
    return `Could not inspect "${this.path}" while reconciling a directory: ${this.cause.reason._tag}.`;
  }
}

/**
 * A directory this tool ensures exists, with an optional permission mode.
 *
 * Nothing else in `dotfiles` can express "make sure `~/.config/foo` exists at
 * `0700`" without also writing a file into it — `Machine.File` and
 * `Machine.ManagedBlock` only create the parent directories a file needs, as
 * a side effect of writing that file, and there is no way to ask for just the
 * directory. This is that primitive.
 */
export const DirectoryProps = Schema.Struct({
  /** Path to the directory. `~` is expanded. */
  path: Schema.String,
  /**
   * POSIX mode, e.g. `0o700`. Left unconstrained when unset: any mode on an
   * existing directory satisfies the recipe.
   */
  mode: Schema.optionalKey(Schema.Number),
});

export type DirectoryProps = typeof DirectoryProps.Type;

/**
 * `mode` is always populated from a live `stat` when observed — it is only
 * ever absent from *desired* state, meaning the recipe does not constrain it.
 */
export const DirectoryState = Schema.Struct({
  path: Schema.String,
  mode: Schema.optionalKey(Schema.Number),
});

export type DirectoryState = typeof DirectoryState.Type;

export interface Directory extends Resource<"Machine.Directory", DirectoryProps, DirectoryState> {}

export const Directory = Resource<Directory>("Machine.Directory");

export const makeDirectoryReconciler: Effect.Effect<
  Reconciler<
    DirectoryProps,
    DirectoryState,
    PlatformError | DirectoryPathIsFile | DirectoryPathUnreadable
  >,
  never,
  FileSystem.FileSystem | MachinePaths
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* MachinePaths;

  return {
    address: (props) => paths.expand(props.path),

    observe: (props) =>
      Effect.gen(function* () {
        const target = paths.expand(props.path);
        const info = yield* fs
          .stat(target)
          .pipe(
            Effect.catchTag("PlatformError", (cause) =>
              isNotFound(cause)
                ? Effect.succeed(undefined)
                : Effect.fail(new DirectoryPathUnreadable({ path: target, cause })),
            ),
          );
        if (info === undefined) return undefined;
        if (info.type !== "Directory") {
          return yield* Effect.fail(new DirectoryPathIsFile({ path: target }));
        }
        return { path: target, mode: Number(info.mode) & 0o777 };
      }),

    desired: (props) =>
      Effect.succeed({
        path: paths.expand(props.path),
        ...(props.mode !== undefined ? { mode: props.mode } : {}),
      }),

    matches: (observed, desired) =>
      observed.path === desired.path &&
      // An unset desired mode means the recipe does not constrain
      // permissions, so any observed mode satisfies it.
      (desired.mode === undefined || observed.mode === desired.mode),

    apply: ({ props, desired }) =>
      Effect.gen(function* () {
        const target = desired.path;
        // `mode` here only takes effect when `makeDirectory` actually creates
        // the directory — the underlying `mkdir` syscall never changes the
        // permissions of a directory that already exists. So a directory that
        // pre-dates this resource (adopted, or created by something else with
        // a different mode) needs an explicit `chmod` below rather than
        // relying on this option alone.
        yield* fs.makeDirectory(target, {
          recursive: true,
          ...(props.mode !== undefined ? { mode: props.mode } : {}),
        });
        if (props.mode !== undefined) yield* fs.chmod(target, props.mode);
        const info = yield* fs.stat(target);
        return { path: target, mode: Number(info.mode) & 0o777 };
      }),
  };
});

export const DirectoryProvider = () => toProvider(Directory, makeDirectoryReconciler);
