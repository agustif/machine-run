import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { MachinePaths } from "./Paths.ts";

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
    readonly snapshot: (target: string) => Effect.Effect<string | undefined, never, never>;
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

export const BackupsLive = () =>
  Layer.effect(
    Backups,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const paths = yield* MachinePaths;

      // Clock rather than `new Date()` directly so a test can pin the stamp.
      const stamp = stampFor(yield* Clock.currentTimeMillis);
      // XDG-ish state location: this is recoverable scratch, not config the
      // user edits and not a cache that's safe to evict mid-run.
      const root = path.join(paths.home, ".local", "state", "machine-run", "backups", stamp);

      return {
        root,
        snapshot: (target: string) =>
          Effect.gen(function* () {
            const absolute = paths.expand(target);
            if (!(yield* fs.exists(absolute))) return undefined;

            // Mirror the full source path under the run directory so two
            // files sharing a basename can't clobber each other's backup.
            const destination = path.join(root, absolute.replace(/^[/\\]+/, ""));
            yield* fs.makeDirectory(path.dirname(destination), {
              recursive: true,
            });
            yield* fs.copy(absolute, destination);
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
