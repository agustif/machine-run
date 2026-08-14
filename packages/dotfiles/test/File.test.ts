import { MachinePathsLive, PlatformLive } from "@machine-run/core";
import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { platform as nodePlatform } from "node:os";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import {
  FilePathIsNotFile,
  FilePathUnreadable,
  makeFileReconciler,
  type FileProps,
  type FileState,
} from "../src/File.ts";

const layer = Layer.mergeAll(MachinePathsLive(), PlatformLive(), NodeCrypto.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const applyCtx = {
  exec: () => Effect.die("not used"),
  snapshot: () => Effect.succeed(undefined),
};
const observeCtx = { exec: () => Effect.die("not used") };

// Windows' chmod cannot express an unreadable directory/file, so the
// permission-denied fixtures below are POSIX-only. ACL translation has its own
// Windows coverage in the core tests.
const POSIX_PERMISSIONS_AVAILABLE = nodePlatform() !== "win32";

/** A real `ctx.snapshot`, so `apply`'s own backup capture has something to
 * actually copy — the stub above always reports "nothing to preserve".
 * `fs` is resolved by the caller, since `ApplyContext.snapshot` itself may
 * not require any service (`R = never`). */
const snapshottingCtx = (fs: FileSystem.FileSystem) => ({
  exec: () => Effect.die("not used"),
  snapshot: (target: string) =>
    fs.copy(target, `${target}.bak`).pipe(
      Effect.as(`${target}.bak`),
      Effect.orElseSucceed(() => undefined),
    ),
});

/**
 * A path that cannot be inspected is not a path with nothing at it.
 *
 * Folding the two together would let `apply` overwrite a file it could not
 * see, and would replace the error naming the permission problem with
 * whatever the subsequent write happened to fail with.
 */
it.effect.skipIf(!POSIX_PERMISSIONS_AVAILABLE)(
  "observe raises a typed error, not absence, when the parent directory is unreadable",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeFileReconciler;
      const dir = yield* fs.makeTempDirectoryScoped();

      const blocked = path.join(dir, "blocked");
      yield* fs.makeDirectory(blocked);
      const target = path.join(blocked, "file");
      yield* fs.writeFileString(target, "content nobody can see right now");
      yield* fs.chmod(blocked, 0o000);

      // Restored with `Effect.ensuring` rather than `finally`, so it still
      // runs if the assertion fails or the fiber is interrupted.
      const failure = yield* reconciler
        .observe({ path: target, content: "x" }, observeCtx)
        .pipe(
          Effect.flip,
          Effect.ensuring(fs.chmod(blocked, 0o755).pipe(Effect.orElseSucceed(() => undefined))),
        );

      expect(failure).toBeInstanceOf(FilePathUnreadable);
    }).pipe(Effect.provide(layer)),
);

/**
 * The sharpest case in MUST_CLEANUP.md 0.4: `stat` above raises
 * `FilePathUnreadable` for anything that isn't a genuine not-found, but the
 * read that follows it used to discard that discipline with
 * `Effect.orElseSucceed(() => "")`. `0o200` (write-only, no read) isolates
 * exactly that gap — `stat` only needs to resolve the path, which it can do
 * regardless of the file's own mode bits, so it still succeeds; the read
 * that follows does not.
 */
it.effect("observe raises a typed error when a directory occupies the file path", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeFileReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "directory-not-file");
    yield* fs.makeDirectory(target);

    const failure = yield* reconciler
      .observe({ path: target, content: "x" }, observeCtx)
      .pipe(Effect.flip);

    expect(failure).toBeInstanceOf(FilePathIsNotFile);
  }).pipe(Effect.provide(layer)),
);

it.effect.skipIf(!POSIX_PERMISSIONS_AVAILABLE)(
  "observe raises a typed error, not empty content, when the file itself cannot be read after stat succeeds",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeFileReconciler;
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = path.join(dir, "write-only");

      yield* fs.writeFileString(target, "content nobody can read right now");
      yield* fs.chmod(target, 0o200);

      const failure = yield* reconciler
        .observe({ path: target, content: "x" }, observeCtx)
        .pipe(
          Effect.flip,
          Effect.ensuring(fs.chmod(target, 0o644).pipe(Effect.orElseSucceed(() => undefined))),
        );

      expect(failure).toBeInstanceOf(FilePathUnreadable);
    }).pipe(Effect.provide(layer)),
);
it.effect(
  "live drift: content hand-edited after being written is detected on the next observe",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeFileReconciler;
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = path.join(dir, "config");

      const props: FileProps = { path: target, content: "generated line" };
      const desired = yield* reconciler.desired(props);
      yield* reconciler.apply({ props, observed: Option.none(), desired }, applyCtx);

      // Something other than this tool edits the file between plans — the
      // core case a reconciler model exists to catch.
      yield* fs.writeFileString(target, "hand-edited, not what the recipe asked for");

      const observed = yield* reconciler.observe(props, observeCtx);
      expect(Option.isSome(observed)).toBe(true);
      // Comparing against a remembered hash instead of the live file would
      // never see this: `observe` must read the disk, not its own history.
      expect(reconciler.matches(Option.getOrThrow(observed), desired)).toBe(false);
    }).pipe(Effect.provide(layer)),
);

it.effect("mode participates in matching once the recipe pins one, and apply converges it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeFileReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "secret-ish");

    const props: FileProps = { path: target, content: "x", mode: 0o600 };
    const desired = yield* reconciler.desired(props);
    const applied = yield* reconciler.apply({ props, observed: Option.none(), desired }, applyCtx);
    expect(applied.mode).toBe(0o600);

    const info = yield* fs.stat(target);
    expect(Number(info.mode) & 0o777).toBe(0o600);

    // A later recipe pinning a different mode is real drift, not noise.
    const props2: FileProps = { ...props, mode: 0o644 };
    const desired2 = yield* reconciler.desired(props2);
    expect(reconciler.matches(applied, desired2)).toBe(false);

    const applied2 = yield* reconciler.apply(
      { props: props2, observed: Option.some(applied), desired: desired2 },
      applyCtx,
    );
    expect(applied2.mode).toBe(0o644);
    const info2 = yield* fs.stat(target);
    expect(Number(info2.mode) & 0o777).toBe(0o644);
  }).pipe(Effect.provide(layer)),
);

it.effect("an unset mode is unconstrained: any observed mode satisfies it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeFileReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "unconstrained");

    const props: FileProps = { path: target, content: "x" };
    const desired = yield* reconciler.desired(props);
    expect(desired.mode).toBeUndefined();

    // A real file with a specific mode the recipe never asked to pin.
    yield* fs.writeFileString(target, "x", { mode: 0o640 });
    const observed = yield* reconciler.observe(props, observeCtx);
    expect(Option.getOrThrow(observed).mode).toBe(0o640);
    expect(reconciler.matches(Option.getOrThrow(observed), desired)).toBe(true);

    // Even a very different real mode still satisfies an unconstrained
    // desired state — only a *pinned* mode should ever cause a rewrite.
    yield* fs.chmod(target, 0o755);
    const observedAgain = yield* reconciler.observe(props, observeCtx);
    expect(reconciler.matches(Option.getOrThrow(observedAgain), desired)).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("a moved `path` is an independent address: the old file is left untouched", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeFileReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const oldPath = path.join(dir, "old-location");
    const newPath = path.join(dir, "new-location");

    const oldProps: FileProps = { path: oldPath, content: "same content" };
    const oldDesired = yield* reconciler.desired(oldProps);
    yield* reconciler.apply(
      { props: oldProps, observed: Option.none(), desired: oldDesired },
      applyCtx,
    );

    // The recipe now points at a new path — a distinct address, with
    // nothing observed there yet.
    const newProps: FileProps = { path: newPath, content: "same content" };
    expect(reconciler.address(oldProps)).not.toBe(reconciler.address(newProps));
    const observedAtNew = yield* reconciler.observe(newProps, observeCtx);
    expect(observedAtNew).toStrictEqual(Option.none());

    yield* reconciler.apply(
      {
        props: newProps,
        observed: Option.none(),
        desired: yield* reconciler.desired(newProps),
      },
      applyCtx,
    );

    // Nothing reconciles the old location on a move: `delete` is a
    // documented no-op (AGENTS.md rule 10) and there is no `dependsOn` that
    // would let one resource react to another's props changing, so the old
    // file survives a "move" made purely by editing the recipe.
    expect(yield* fs.exists(oldPath)).toBe(true);
    expect(yield* fs.exists(newPath)).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("drift is empty exactly when matches is true, and names content and mode", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeFileReconciler;
    const drift = reconciler.drift;
    if (drift === undefined) return yield* Effect.die("expected drift to be defined");

    const desired: FileState = { path: "/tmp/x", hash: "aaa", mode: 0o600 };

    const same: FileState = { path: "/tmp/x", hash: "aaa", mode: 0o600 };
    expect(reconciler.matches(same, desired)).toBe(true);
    expect(drift(same, desired)).toEqual([]);

    const contentDrifted: FileState = { path: "/tmp/x", hash: "bbb", mode: 0o600 };
    expect(reconciler.matches(contentDrifted, desired)).toBe(false);
    const contentFields = drift(contentDrifted, desired);
    expect(contentFields.map((f) => f.field)).toEqual(["content"]);
    // A hash is not ordered — "behind"/"ahead" would be an invented claim.
    expect(contentFields[0]?.direction).toBeUndefined();

    // Observed behind desired: 0o600 < 0o644.
    const modeBehind: FileState = { path: "/tmp/x", hash: "aaa", mode: 0o600 };
    const desiredHigherMode: FileState = { path: "/tmp/x", hash: "aaa", mode: 0o644 };
    expect(reconciler.matches(modeBehind, desiredHigherMode)).toBe(false);
    const behindFields = drift(modeBehind, desiredHigherMode);
    expect(behindFields).toEqual([
      { field: "mode", observed: "600", desired: "644", direction: "behind" },
    ]);

    // Observed ahead of desired: 0o644 > 0o600.
    const modeAhead: FileState = { path: "/tmp/x", hash: "aaa", mode: 0o644 };
    expect(reconciler.matches(modeAhead, desired)).toBe(false);
    const aheadFields = drift(modeAhead, desired);
    expect(aheadFields).toEqual([
      { field: "mode", observed: "644", desired: "600", direction: "ahead" },
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "drift reports a constrained mode with no observed value, but never invents a direction",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeFileReconciler;
      const drift = reconciler.drift;
      if (drift === undefined) return yield* Effect.die("expected drift to be defined");

      // `observed.mode` is optional in the schema; this can only arise from a
      // hand-built state (a live `observe` always populates it), but `drift`
      // must still not invent a number to order against.
      const observed: FileState = { path: "/tmp/x", hash: "aaa" };
      const desired: FileState = { path: "/tmp/x", hash: "aaa", mode: 0o600 };
      expect(reconciler.matches(observed, desired)).toBe(false);
      expect(drift(observed, desired)).toEqual([
        { field: "mode", observed: "unset", desired: "600" },
      ]);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "unapply restores the file to what it was before the last apply, when a backup was captured",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeFileReconciler;
      const unapply = reconciler.unapply;
      if (unapply === undefined) return yield* Effect.die("expected unapply to be defined");
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = path.join(dir, "config");

      yield* fs.writeFileString(target, "hand-written before machine-run");

      const props: FileProps = { path: target, content: "generated" };
      const desired = yield* reconciler.desired(props);
      const observedBefore = yield* reconciler.observe(props, observeCtx);
      // The engine captures the backup and hands the path to `apply` — see
      // `ApplyInput.snapshot`. Passing it explicitly is what this test is for:
      // `File` must fold it into its own state, not take its own snapshot.
      const archived = `${target}.bak`;
      yield* fs.copy(target, archived);
      const output = yield* reconciler.apply(
        { props, observed: observedBefore, desired, snapshot: archived },
        snapshottingCtx(fs),
      );
      expect(output.backupPath).toBe(archived);
      expect(yield* fs.readFileString(target)).toBe("generated");

      const observedNow = Option.getOrThrow(yield* reconciler.observe(props, observeCtx));
      yield* unapply({ props, observed: observedNow, recorded: output }, snapshottingCtx(fs));

      expect(yield* fs.readFileString(target)).toBe("hand-written before machine-run");
    }).pipe(Effect.provide(layer)),
);

it.effect("unapply removes the file it created when nothing was there before", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeFileReconciler;
    const unapply = reconciler.unapply;
    if (unapply === undefined) return yield* Effect.die("expected unapply to be defined");
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "config");

    const props: FileProps = { path: target, content: "generated" };
    const desired = yield* reconciler.desired(props);
    const output = yield* reconciler.apply(
      { props, observed: Option.none(), desired },
      snapshottingCtx(fs),
    );
    expect(output.backupPath).toBeUndefined();

    const observed = Option.getOrThrow(yield* reconciler.observe(props, observeCtx));
    yield* unapply({ props, observed, recorded: output }, snapshottingCtx(fs));

    expect(yield* fs.exists(target)).toBe(false);
  }).pipe(Effect.provide(layer)),
);
