import { MachinePaths } from "@machine-run/core";
import { type Reconciler, toProvider } from "@machine-run/engine";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { PlatformError } from "effect/PlatformError";

export class SymlinkSourceMissing extends Data.TaggedError("SymlinkSourceMissing")<{
  source: string;
}> {
  override get message() {
    return `Symlink source "${this.source}" does not exist. Content is never fabricated for a symlink target — copy the reviewed file or directory into place first, then point this resource at it.`;
  }
}

/**
 * Raised when the path a symlink should occupy cannot be inspected at all — an
 * unreadable parent directory, a permissions problem, an I/O error.
 *
 * Distinct from "there is no symlink here yet", which is an ordinary state to
 * converge from. Collapsing both into absence would make reconcile attempt
 * creation over an unreadable path and surface whatever error that attempt
 * produced, hiding the one that explains the problem.
 */
export class SymlinkPathUnreadable extends Data.TaggedError("SymlinkPathUnreadable")<{
  path: string;
  cause: PlatformError;
}> {
  override get message() {
    return `Could not inspect "${this.path}" while reconciling a symlink: ${this.cause.reason._tag}.`;
  }
}

/**
 * A file or directory made available at `path` by symlinking it to `source` —
 * typically a reviewed, checked-in location. Prefer this over
 * {@link File}/{@link ManagedBlock} for assets that are naturally a directory,
 * such as an editor's `skills/` folder, rather than something to template as a
 * string.
 *
 * Content is never fabricated: if `source` does not exist, reconcile fails
 * rather than creating an empty placeholder. Bringing a real config under
 * management is a deliberate, reviewed step, because these directories can also
 * hold credentials that must not be copied into a repository unreviewed.
 */
export const SymlinkProps = Schema.Struct({
  /** Path that should become a symlink, e.g. `~/.claude/skills`. `~` is expanded. */
  path: Schema.String,
  /** Path to the source of truth it should point at. `~` is expanded. */
  source: Schema.String,
});

export type SymlinkProps = typeof SymlinkProps.Type;

export const SymlinkState = Schema.Struct({
  path: Schema.String,
  source: Schema.String,
});

export type SymlinkState = typeof SymlinkState.Type;

export interface Symlink
  extends Resource<"Machine.Symlink", SymlinkProps, SymlinkState> {}

export const Symlink = Resource<Symlink>("Machine.Symlink");

/** Effect's `PlatformError` carries a normalised reason, so this is a field read. */
const isNotFound = (error: PlatformError) => error.reason._tag === "NotFound";

export const makeSymlinkReconciler: Effect.Effect<
  Reconciler<SymlinkProps, SymlinkState, PlatformError | SymlinkSourceMissing | SymlinkPathUnreadable>,
  never,
  FileSystem.FileSystem | Path.Path | MachinePaths
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* MachinePaths;

  /**
   * The link's current target, or `None` when this path is not a symlink.
   *
   * `readLink` succeeding is the definition of "this is a symlink", so it is
   * the primary probe. Effect's `FileSystem` exposes no `lstat`, so a failure
   * is disambiguated by a follow-up `stat`: if that succeeds, something real
   * but non-symlink occupies the path; if it fails too and the original reason
   * was `NotFound`, the path is genuinely empty. Anything else is surfaced.
   */
  const currentTarget = (
    linkPath: string,
  ): Effect.Effect<Option.Option<string>, SymlinkPathUnreadable> =>
    fs.readLink(linkPath).pipe(
      Effect.map((target) => Option.some(paths.expand(target))),
      Effect.catchTag("PlatformError", (cause) =>
        fs.stat(linkPath).pipe(
          Effect.as(Option.none<string>()),
          Effect.catchTag("PlatformError", () =>
            isNotFound(cause)
              ? Effect.succeed(Option.none<string>())
              : Effect.fail(new SymlinkPathUnreadable({ path: linkPath, cause })),
          ),
        ),
      ),
    );

  /**
   * Whether anything occupies this path, including a symlink whose target is
   * gone.
   *
   * `fs.exists` follows symlinks and so answers `false` for a dangling link.
   * Deciding whether to clear the path on that answer alone would leave the
   * dangling link in place and fail the subsequent `symlink` with `EEXIST` —
   * the state produced by renaming a directory that other links point at.
   */
  const occupied = (target: string) =>
    Effect.gen(function* () {
      if (Option.isSome(yield* currentTarget(target))) return true;
      return yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false));
    });

  return {
    address: (props) => paths.expand(props.path),
    snapshotBeforeApply: true,

    observe: (props) =>
      Effect.gen(function* () {
        const target = paths.expand(props.path);
        const current = yield* currentTarget(target);
        return Option.match(current, {
          onNone: () => undefined,
          onSome: (source) => ({ path: target, source }),
        });
      }),

    desired: (props) =>
      Effect.succeed({
        path: paths.expand(props.path),
        source: paths.expand(props.source),
      }),

    // Both sides are normalised by `expand`, so `~/vault`, `/Users/a/vault` and
    // `/Users/a/vault/` compare equal. Comparing raw strings would make a
    // trailing slash in a recipe report a change on every plan, forever.
    matches: (observed, desired) =>
      observed.path === desired.path && observed.source === desired.source,

    apply: ({ desired }) =>
      Effect.gen(function* () {
        if (!(yield* fs.exists(desired.source))) {
          return yield* Effect.fail(
            new SymlinkSourceMissing({ source: desired.source }),
          );
        }

        yield* fs.makeDirectory(path.dirname(desired.path), { recursive: true });
        if (yield* occupied(desired.path)) {
          yield* fs.remove(desired.path, { recursive: true });
        }
        yield* fs.symlink(desired.source, desired.path);
        return desired;
      }),
  };
});

export const SymlinkProvider = () => toProvider(Symlink, makeSymlinkReconciler);
