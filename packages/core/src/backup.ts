import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * If `target` already exists, copies it into `<backupsRoot>/<timestamp>/<basename>`.
 *
 * Callers gate this on `output === undefined` (a resource's first-ever
 * reconcile) so a real pre-existing file/directory always gets a snapshot
 * before machine-run's dotfiles resources touch it for the first time — and
 * so it runs exactly once per adoption, not on every apply.
 */
export const backupIfExists = (target: string, backupsRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const exists = yield* fs.exists(target);
    if (!exists) return;

    const stamp = yield* Effect.sync(() =>
      new Date().toISOString().replace(/[:.]/g, "-"),
    );
    const destination = path.join(backupsRoot, stamp, path.basename(target));
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
    yield* fs.copy(target, destination);
  });
