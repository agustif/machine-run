import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { platform as nodePlatform } from "node:os";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { ensureParentDir, posixMode, readIfPresent, statIfPresent } from "../src/Fs.ts";

/** A stand-in for the typed error a real resource would raise on "unreadable". */
class TestUnreadable extends Data.TaggedError("TestUnreadable")<{
  path: string;
  cause: PlatformError;
}> {}

const onUnreadable = (path: string) => (cause: PlatformError) =>
  new TestUnreadable({ path, cause });

// Windows' chmod only toggles the read-only attribute; it cannot create the
// POSIX unreadable-parent fixture these two tests specifically exercise.
const POSIX_PERMISSIONS_AVAILABLE = nodePlatform() !== "win32";

it.effect("readIfPresent reports a genuinely absent file as Option.none, not an error", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "does-not-exist");

    const result = yield* readIfPresent(fs, target, onUnreadable(target));
    expect(Option.isNone(result)).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("readIfPresent distinguishes a present-but-empty file from an absent one", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "empty");
    yield* fs.writeFileString(target, "");

    const result = yield* readIfPresent(fs, target, onUnreadable(target));
    // Collapsing this into Option.none() alongside a real absence is exactly
    // the bug `readContentOrEmpty`-shaped helpers had: an empty file and no
    // file at all became the same signal.
    expect(result).toEqual(Option.some(""));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(!POSIX_PERMISSIONS_AVAILABLE)(
  "readIfPresent raises the caller's typed error for an unreadable file, not Option.none",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const blocked = path.join(dir, "blocked");
      yield* fs.makeDirectory(blocked);
      const target = path.join(blocked, "file");
      yield* fs.writeFileString(target, "content nobody can see right now");
      yield* fs.chmod(blocked, 0o000);

      // If the `isNotFound` branch were removed (folding every failure into
      // "absent", the bug this helper exists to prevent), this would resolve
      // successfully to `Option.none()` instead of failing, and the
      // assertion below would fail.
      const failure = yield* readIfPresent(fs, target, onUnreadable(target)).pipe(
        Effect.flip,
        Effect.ensuring(fs.chmod(blocked, 0o755).pipe(Effect.orElseSucceed(() => undefined))),
      );

      expect(failure).toBeInstanceOf(TestUnreadable);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("statIfPresent reports a genuinely absent path as Option.none, not an error", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "does-not-exist");

    const result = yield* statIfPresent(fs, target, onUnreadable(target));
    expect(Option.isNone(result)).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(!POSIX_PERMISSIONS_AVAILABLE)(
  "statIfPresent raises the caller's typed error for an unreadable parent, not Option.none",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const blocked = path.join(dir, "blocked");
      yield* fs.makeDirectory(blocked);
      const target = path.join(blocked, "file");
      yield* fs.writeFileString(target, "x");
      yield* fs.chmod(blocked, 0o000);

      const failure = yield* statIfPresent(fs, target, onUnreadable(target)).pipe(
        Effect.flip,
        Effect.ensuring(fs.chmod(blocked, 0o755).pipe(Effect.orElseSucceed(() => undefined))),
      );

      expect(failure).toBeInstanceOf(TestUnreadable);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("posixMode masks off the file-type bits stat also reports", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "file");
    yield* fs.writeFileString(target, "x");
    yield* fs.chmod(target, 0o644);

    const info = yield* fs.stat(target);
    // A raw `info.mode` carries `S_IFREG` (or the directory/symlink
    // equivalent) alongside the permission bits — this is the same
    // `Number(info.mode) & 0o777` seven files each wrote out by hand, and
    // removing the `& 0o777` mask here would fail this assertion against the
    // unmasked value instead of 0o644.
    expect(posixMode(info)).toBe(0o644);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ensureParentDir creates a missing nested parent, recursively, with the given mode", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "a", "b", "c", "file");

    yield* ensureParentDir(fs, path, target, 0o700);

    const info = yield* fs.stat(path.dirname(target));
    expect(info.type).toBe("Directory");
    expect(posixMode(info)).toBe(0o700);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ensureParentDir succeeds without a mode, taking the platform default", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "nested", "file");

    yield* ensureParentDir(fs, path, target);

    const info = yield* fs.stat(path.dirname(target));
    expect(info.type).toBe("Directory");
  }).pipe(Effect.provide(NodeServices.layer)),
);
