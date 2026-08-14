import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { CommandError } from "alchemy/Command";
import { ensureParentDir, statIfPresent } from "./Fs.ts";
import { MachinePaths } from "./Paths.ts";
import { Platform } from "./Platform.ts";
import type { PermissionsTarget } from "./windows/FilePermissions.ts";

/**
 * Applies the restrictive mode a backup needs on a platform where Node's
 * `chmod` is not expressive enough. The engine supplies this from the same
 * command session as the resource being reconciled, so a Windows backup uses
 * the normal, observable command boundary rather than quietly falling back to
 * a read-only attribute.
 */
export type BackupPermissions = (
  path: string,
  mode: number,
  target: PermissionsTarget,
) => Effect.Effect<void, CommandError>;

/** A Windows backup reached the ACL boundary without the engine callback. */
export class BackupPermissionsUnavailable extends Data.TaggedError("BackupPermissionsUnavailable")<{
  path: string;
}> {
  override get message() {
    return `Cannot secure Windows backup path "${this.path}" without the apply command boundary.`;
  }
}

/**
 * Snapshots real, pre-existing files before this tool takes them over.
 *
 * Three properties make the difference between a safety net and clutter:
 *
 * - **One directory per run, not per file.** The timestamp is read once when
 *   the service is built, so an adopting deploy produces a single directory
 *   that can be reviewed or deleted as a unit rather than N near-identical
 *   ones.
 * - **One location, outside the tree being managed.** Everything lands under
 *   `~/.local/state/machine-run/backups/`. Writing beside each source would
 *   scatter copies through the home directory, and would put a copy of
 *   `~/.ssh/config` inside `~/.ssh`, whose permissions `ssh` is strict about.
 * - **Full source paths, mirrored.** Two files can share a basename —
 *   `config` is the obvious one — so keying a backup by basename alone loses
 *   one of them.
 */
export class Backups extends Context.Service<
  Backups,
  {
    /**
     * Copies `target` into this run's backup directory if it exists.
     * Returns the backup path when one was taken.
     *
     * The engine calls this at the two moments where the contents may be a
     * person's own work — a resource's first apply, and the first apply after
     * adopting something already present. Snapshotting on every apply would
     * only ever archive this tool's own previous output.
     */
    readonly snapshot: (
      target: string,
      permissions?: BackupPermissions,
    ) => Effect.Effect<string | undefined, never, never>;
    /** Absolute path of this run's backup directory, for error messages. */
    readonly root: string;
  }
>()("machine-run/Backups") {}

/**
 * `2026-08-13T14-22-05-123Z` — filesystem-safe and lexically sortable, so a
 * directory listing of backups is in chronological order.
 *
 * Built from `DateTime` rather than `Date` so the instant comes from Effect's
 * clock and a test can pin it; `:` and `.` are not portable in path segments.
 */
const stampFor = (millis: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(millis)).replaceAll(/[:.]/g, "-");

const splitSegments = (value: string): readonly string[] =>
  value.split(/[/\\]+/).filter((segment) => segment.length > 0);

/**
 * The source path, rewritten into segments that can nest under the backup
 * root on any platform.
 *
 * A Windows absolute path carries its drive as `C:`, and `:` is one of the
 * characters Windows forbids in a path segment. Mirroring such a path verbatim
 * asks for a directory literally named `C:`, which cannot be created — so
 * `makeDirectory` fails, the failure is logged rather than raised (a backup
 * must never abort a deploy), and the caller receives no backup path. The
 * overwrite then proceeds with no safety net, which is the single outcome this
 * service exists to prevent. The drive keeps its letter as an ordinary
 * segment: `C:\Users\me\.zshrc` mirrors to `C/Users/me/.zshrc`.
 *
 * A UNC path (`\\server\share\file`) is prefixed with `UNC` so its host and
 * share cannot collide with a local directory that happens to be called
 * `server/share`.
 */
export const mirrorSegments = (absolute: string): readonly string[] => {
  const unc = /^[/\\]{2}([^/\\]+)[/\\]+(.*)$/.exec(absolute);
  if (unc !== null) return ["UNC", unc[1] ?? "", ...splitSegments(unc[2] ?? "")];

  const drive = /^([A-Za-z]):(.*)$/.exec(absolute);
  if (drive !== null) return [drive[1] ?? "", ...splitSegments(drive[2] ?? "")];

  return splitSegments(absolute);
};

export const BackupsLive = () =>
  Layer.effect(
    Backups,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const paths = yield* MachinePaths;
      const platform = yield* Platform;

      // Clock rather than `new Date()` directly so a test can pin the stamp.
      const stamp = stampFor(yield* Clock.currentTimeMillis);
      // XDG-ish state location: this is recoverable scratch, not config the
      // user edits and not a cache that's safe to evict mid-run.
      const root = path.join(paths.home, ".local", "state", "machine-run", "backups", stamp);

      return {
        root,
        snapshot: (target: string, permissions?: BackupPermissions) =>
          Effect.gen(function* () {
            const absolute = paths.expand(target);
            const present = yield* statIfPresent(fs, absolute, (cause) => cause);
            if (Option.isNone(present)) return undefined;

            // Mirror the full source path under the run directory so two
            // files sharing a basename can't clobber each other's backup.
            const destination = path.join(root, ...mirrorSegments(absolute));
            // Backups may contain an SSH key, token, or other hand-placed
            // credential. Keep both the containing directories and the copy
            // private even when the process umask is permissive. This is a
            // backup outside Alchemy's JSON state, but it is still sensitive
            // machine data and must not become a second world-readable copy.
            yield* ensureParentDir(fs, path, destination, 0o700);
            const secure = (target: string, mode: number, kind: PermissionsTarget) => {
              if (!platform.isWindows) return fs.chmod(target, mode).pipe(Effect.asVoid);
              if (permissions === undefined) {
                return Effect.fail(new BackupPermissionsUnavailable({ path: target }));
              }
              return permissions(target, mode, kind);
            };
            const segments = mirrorSegments(absolute);
            const directories = [
              root,
              ...segments
                .slice(0, -1)
                .map((_, index) => path.join(root, ...segments.slice(0, index + 1))),
            ];
            for (const directory of directories) {
              yield* secure(directory, 0o700, "directory");
            }
            yield* fs.copy(absolute, destination);
            yield* secure(destination, 0o600, "file");
            return destination;
          }).pipe(
            // A failed backup must not abort the deploy, but it must never
            // be swallowed silently either — the operator needs to know the
            // safety net wasn't there before the overwrite happened.
            Effect.tapError((error) =>
              Effect.logWarning(
                `machine-run could not back up "${target}" before taking it over: ${error}`,
              ),
            ),
            Effect.orElseSucceed(() => undefined),
          ),
      };
    }),
  );
