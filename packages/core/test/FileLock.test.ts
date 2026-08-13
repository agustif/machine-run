import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { FileLock, FileLockLive } from "../src/FileLock.ts";

/**
 * Appends a line by reading the whole file, adding to it, and writing it back.
 *
 * This models how resources that own a region of a shared file converge: the
 * read and the write are separate steps, so two of them running concurrently
 * can interleave.
 */
const appendViaReadModifyWrite = (target: string, line: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const before = yield* fs.readFileString(target).pipe(Effect.orElseSucceed(() => ""));
    // Yield control between the read and the write so the interleaving this
    // guards against is actually exercised rather than hidden by the two
    // steps happening to run without a suspension between them.
    yield* Effect.yieldNow;
    yield* fs.writeFileString(target, `${before}${line}\n`);
  });

const LINES = Array.from({ length: 20 }, (_, index) => `line-${index}`);

it.effect("concurrent read-modify-write without a lock loses updates", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "shared.conf");
    yield* fs.writeFileString(target, "");

    yield* Effect.all(
      LINES.map((line) => appendViaReadModifyWrite(target, line)),
      { concurrency: "unbounded" },
    );

    const written = yield* fs.readFileString(target);
    const present = LINES.filter((line) => written.includes(line));
    // Establishes that the hazard is real for this access pattern, so the
    // locked case below is demonstrating the lock and not a no-op.
    expect(present.length).toBeLessThan(LINES.length);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("the lock serialises writers to one path so every update survives", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const locks = yield* FileLock;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "shared.conf");
    yield* fs.writeFileString(target, "");

    yield* Effect.all(
      LINES.map((line) => locks.withLock(target, appendViaReadModifyWrite(target, line))),
      { concurrency: "unbounded" },
    );

    const written = yield* fs.readFileString(target);
    for (const line of LINES) expect(written).toContain(line);
  }).pipe(Effect.provide(FileLockLive()), Effect.provide(NodeServices.layer)),
);

it.effect("writers to different paths are not serialised against each other", () =>
  Effect.gen(function* () {
    const locks = yield* FileLock;
    let running = 0;
    let peak = 0;

    const track = Effect.gen(function* () {
      running += 1;
      peak = Math.max(peak, running);
      yield* Effect.yieldNow;
      running -= 1;
    });

    yield* Effect.all(
      ["/tmp/a", "/tmp/b", "/tmp/c"].map((p) => locks.withLock(p, track)),
      { concurrency: "unbounded" },
    );

    expect(peak).toBeGreaterThan(1);
  }).pipe(Effect.provide(FileLockLive())),
);
