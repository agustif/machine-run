import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { backupIfExists, sha256 } from "@machine-run/core";

// NOTE: these exercise the same FileSystem sequence Machine.File's reconcile
// performs (mkdir -p, backup-on-first-write, write, hash) directly against a
// real temp dir — NOT the wired-up FileProvider()/Resource itself, since
// that needs alchemy's own test harness (currently broken; see
// packages/system-packages/test for the one thing that IS testable without
// it — the package-manager backends). If alchemy's test harness stabilizes,
// this should be upgraded to a real `stack.deploy(Dotfiles.File(...))` test.

it.effect("writes desired content to a new file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "example.conf");

    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(target, "a = 1\n");

    expect(yield* fs.readFileString(target)).toBe("a = 1\n");
    expect(yield* sha256("a = 1\n")).toBe(yield* sha256(yield* fs.readFileString(target)));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("first write backs up pre-existing content; second write does not re-backup", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "example.conf");
    const backupsRoot = path.join(dir, ".machine-run-backups");
    yield* fs.writeFileString(target, "pre-existing\n");

    // First reconcile (output undefined) — gated backup, then overwrite.
    yield* backupIfExists(target, backupsRoot);
    yield* fs.writeFileString(target, "a = 1\n");
    const firstBackupDirs = yield* fs.readDirectory(backupsRoot);
    expect(firstBackupDirs.length).toBe(1);

    // Second reconcile (output defined) — no backup call, just overwrite.
    yield* fs.writeFileString(target, "a = 2\n");
    const secondBackupDirs = yield* fs.readDirectory(backupsRoot);
    expect(secondBackupDirs.length).toBe(1);
    expect(yield* fs.readFileString(target)).toBe("a = 2\n");
  }).pipe(Effect.provide(NodeServices.layer)),
);
