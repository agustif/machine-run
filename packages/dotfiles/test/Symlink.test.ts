import { backupIfExists } from "@machine-run/core";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// Same scope note as File.test.ts — exercises the underlying FileSystem
// operations Machine.Symlink's reconcile performs, not the wired-up
// SymlinkProvider()/Resource itself.

it.effect("readLink reports no target for a path that isn't a symlink yet", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const link = path.join(dir, "linked");

    const current = yield* fs.readLink(link).pipe(Effect.option);
    expect(current._tag).toBe("None");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("symlink points at source, and readLink confirms it afterward", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const source = path.join(dir, "source.txt");
    const link = path.join(dir, "linked.txt");
    yield* fs.writeFileString(source, "source content\n");

    yield* fs.symlink(source, link);

    const current = yield* fs.readLink(link);
    expect(current).toBe(source);
    expect(yield* fs.readFileString(link)).toBe("source content\n");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("replacing a real file at the link path backs it up first", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const source = path.join(dir, "source.txt");
    const link = path.join(dir, "linked.txt");
    const backupsRoot = path.join(dir, ".machine-run-backups");
    yield* fs.writeFileString(source, "source content\n");
    yield* fs.writeFileString(link, "pre-existing real content\n");

    yield* backupIfExists(link, backupsRoot);
    yield* fs.remove(link, { recursive: true });
    yield* fs.symlink(source, link);

    expect(yield* fs.readFileString(link)).toBe("source content\n");
    expect(yield* fs.exists(backupsRoot)).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);
