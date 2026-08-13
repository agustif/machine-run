import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { backupIfExists } from "../src/backup.ts";

it.effect("does nothing when the target doesn't exist", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "missing.txt");
    const backupsRoot = path.join(dir, ".backups");

    yield* backupIfExists(target, backupsRoot);

    expect(yield* fs.exists(backupsRoot)).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("copies existing content into a timestamped backup dir", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "example.conf");
    const backupsRoot = path.join(dir, ".backups");
    yield* fs.writeFileString(target, "original content\n");

    yield* backupIfExists(target, backupsRoot);

    const stampDirs = yield* fs.readDirectory(backupsRoot);
    expect(stampDirs.length).toBe(1);
    const backedUp = yield* fs.readFileString(
      path.join(backupsRoot, stampDirs[0], "example.conf"),
    );
    expect(backedUp).toBe("original content\n");
  }).pipe(Effect.provide(NodeServices.layer)),
);
