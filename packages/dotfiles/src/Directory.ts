import { isNotFound, MachinePaths, Platform, Windows } from "@machine-run/core";
import { type Drift, type DriftField, type Reconciler, toProvider } from "@machine-run/engine";
import { Resource } from "alchemy/Resource";
import * as Boolean from "effect/Boolean";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as UndefinedOr from "effect/UndefinedOr";
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
  /**
   * `icacls <path>`'s raw listing, on Windows only.
   *
   * Windows has no POSIX mode to observe: Node reports `0o666` for every file
   * and `chmod` only toggles the read-only bit, so comparing `mode` there is
   * comparing a constant and reports drift forever. The ACL is what actually
   * carries the intent, and it has to be captured in `observe` because `matches`
   * is synchronous and cannot shell out.
   */
  acl: Schema.optionalKey(Schema.String),
});

export type DirectoryState = typeof DirectoryState.Type;

export interface Directory extends Resource<"Machine.Directory", DirectoryProps, DirectoryState> {}

export const Directory = Resource<Directory>("Machine.Directory");

/**
 * Whether an observed directory's permissions satisfy the desired mode.
 *
 * Two genuinely different questions behind one name. On POSIX the mode is the
 * truth and equality is the test. On Windows there is no mode to compare, so the
 * test is whether the live ACL grants no more than the mode intends — and an ACL
 * that could not be read is *not* treated as satisfied, because "cannot confirm"
 * must converge by re-applying rather than by assuming.
 */
const modeSatisfied = (
  platform: typeof Platform.Service,
  observed: DirectoryState,
  desired: DirectoryState,
): boolean => {
  // An unset desired mode means the recipe does not constrain permissions.
  if (desired.mode === undefined) return true;
  if (!platform.isWindows) return observed.mode === desired.mode;
  return Windows.aclSatisfiesMode(
    UndefinedOr.match(observed.acl, {
      onUndefined: () => Option.none<string>(),
      onDefined: (acl) => Option.some(acl),
    }),
    observed.path,
    desired.mode,
    "directory",
  );
};

export const makeDirectoryReconciler: Effect.Effect<
  Reconciler<
    DirectoryProps,
    DirectoryState,
    PlatformError | DirectoryPathIsFile | DirectoryPathUnreadable
  >,
  never,
  FileSystem.FileSystem | MachinePaths | Platform
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* MachinePaths;
  const platform = yield* Platform;

  return {
    address: (props) => paths.expand(props.path),

    observe: (props, ctx) =>
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
        if (info === undefined) return Option.none();
        if (info.type !== "Directory") {
          return yield* Effect.fail(new DirectoryPathIsFile({ path: target }));
        }
        const mode = Number(info.mode) & 0o777;
        if (!platform.isWindows) return Option.some({ path: target, mode });
        // A failed listing is left absent rather than raised: the directory is
        // there, and `matches` treats a missing ACL as "cannot confirm", which
        // converges by re-applying rather than by claiming satisfaction.
        const acl = yield* Windows.readAcl(ctx.exec, target);
        return Option.some({
          path: target,
          mode,
          ...Option.match(acl, { onNone: () => ({}), onSome: (value) => ({ acl: value }) }),
        });
      }),

    desired: (props) =>
      Effect.succeed({
        path: paths.expand(props.path),
        ...(props.mode !== undefined ? { mode: props.mode } : {}),
      }),

    matches: (observed, desired) =>
      observed.path === desired.path && modeSatisfied(platform, observed, desired),

    drift: (observed, desired): Drift => {
      const fields: DriftField[] = [];
      if (observed.path !== desired.path) {
        fields.push({ field: "path", observed: observed.path, desired: desired.path });
      }
      if (desired.mode !== undefined && observed.mode !== desired.mode) {
        const desiredMode = desired.mode;
        // `observed.mode` can genuinely be absent — not a value to order
        // against, so `direction` is only set when both sides are real.
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

    apply: ({ props, desired }, ctx) =>
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
        // `chmod` on Windows only toggles the read-only bit, so a mode set that
        // way is never observable and this resource would re-apply forever. The
        // ACL is what carries the intent there.
        if (props.mode !== undefined) {
          yield* Boolean.match(platform.isWindows, {
            onFalse: () => fs.chmod(target, props.mode ?? 0),
            onTrue: () =>
              Windows.applyMode(ctx.exec, target, props.mode ?? 0, "directory").pipe(
                Effect.orElseSucceed(() => undefined),
              ),
          });
        }
        const info = yield* fs.stat(target);
        return { path: target, mode: Number(info.mode) & 0o777 };
      }),

    // `apply`'s only effect is ensuring the directory exists — never its
    // contents. Removing it is only honest when it's still empty: anything
    // placed inside since (by another resource, or by hand) means this is no
    // longer purely "what apply created", and the safest undo is to leave it.
    unapply: ({ observed }) =>
      Effect.gen(function* () {
        const entries = yield* fs.readDirectory(observed.path);
        // `recursive` is needed for Node's `rm` to accept a directory target
        // at all — safe here because the emptiness check above means there
        // is nothing for it to actually recurse into.
        if (entries.length === 0) yield* fs.remove(observed.path, { recursive: true });
      }),
  };
});

export const DirectoryProvider = () => toProvider(Directory, makeDirectoryReconciler);
