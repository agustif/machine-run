import {
  Backups,
  FileLockLive,
  MachinePathsLive,
  PlatformFor,
  silentSession,
} from "@machine-run/core";
import { NodeServices } from "@effect/platform-node";
import { toProvider } from "@machine-run/engine";
import { expect, it } from "@effect/vitest";
import { CommandExecutor } from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import {
  makeSymlinkReconciler,
  Symlink,
  type SymlinkProps,
  type SymlinkState,
} from "../src/Symlink.ts";

/**
 * Proves the adoption-backup gate documented on `Reconciler.snapshotBeforeApply`
 * and implemented in `toProvider`'s generated `reconcile` — not in
 * `Machine.Symlink` itself: a snapshot is taken on a resource's true first
 * apply and on the first apply after adopting something already present, but
 * never on a routine update or a no-op.
 *
 * `Machine.Symlink` is the vehicle because it is the resource in this package
 * that sets `snapshotBeforeApply: true` and never calls `ctx.snapshot` itself
 * — its `unapply` undoes by removing the symlink it created, not by restoring
 * a backup, so `apply` has no reason to call `ctx.snapshot`. `Machine.File`
 * and `Machine.Template` no longer fit this role: both now call
 * `ctx.snapshot` themselves on every apply that overwrites something,
 * folding the path into their own `State` so `unapply` can restore it on a
 * later run (see their own doc comments). That call would double-count
 * against this suite's assertions, which is exactly why this file moved off
 * `Machine.File`.
 */
const CommandExecutorStub = Layer.succeed(CommandExecutor, {
  spawn: () => Effect.die("Machine.Symlink never runs a command"),
  run: () => Effect.die("Machine.Symlink never runs a command"),
});

/** Counts calls instead of writing real backups, so the gate can be asserted directly rather than inferred from files on disk. */
const fakeBackups = (calls: { count: number }) =>
  Layer.succeed(Backups, {
    root: "/fake/backups",
    snapshot: (target: string) =>
      Effect.sync(() => {
        calls.count += 1;
        return `/fake/backups/${target}`;
      }),
  });

/** Everything `toProvider(Symlink, ...)` and the test body itself need, with `Backups` faked so snapshot calls are countable. */
const supportLayers = (calls: { count: number }) =>
  Layer.mergeAll(CommandExecutorStub, FileLockLive(), fakeBackups(calls)).pipe(
    Layer.provideMerge(Layer.mergeAll(MachinePathsLive(), PlatformFor("linux"))),
    Layer.provideMerge(NodeServices.layer),
  );

const reconcile = (
  news: SymlinkProps,
  olds: SymlinkProps | undefined,
  output: SymlinkState | undefined,
) =>
  Effect.gen(function* () {
    const provider = yield* Symlink.Provider;
    return yield* provider.reconcile({
      id: "s",
      fqn: "s",
      instanceId: "s",
      news,
      olds,
      output,
      session: silentSession,
      bindings: [],
    });
  }).pipe(Effect.provide(toProvider(Symlink, makeSymlinkReconciler)));

it.effect("snapshots on a true first apply — nothing recorded yet", () => {
  const calls = { count: 0 };
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "link");
    const source = path.join(dir, "source");
    yield* fs.writeFileString(source, "reviewed content");

    yield* reconcile({ path: target, source }, undefined, undefined);

    expect(calls.count).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(supportLayers(calls)));
});

it.effect(
  "snapshots on the first apply after adoption — output recorded, olds still undefined",
  () => {
    const calls = { count: 0 };
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = path.join(dir, "link");
      const source = path.join(dir, "source");
      yield* fs.writeFileString(source, "reviewed content");
      // A real, non-symlink file already occupies the path — the same shape
      // of pre-existing content `Machine.File`'s own version of this test
      // used, for a resource that replaces rather than rewrites it.
      yield* fs.writeFileString(target, "hand-written before machine-run ever ran");

      // `read` adopted this path on some earlier plan (`output` is
      // populated), but this is the first `reconcile` this resource has ever
      // gone through — `olds`, the previously recorded props, is still
      // undefined.
      yield* reconcile({ path: target, source }, undefined, { path: target, source: "/old" });

      expect(calls.count).toBe(1);
      expect(yield* fs.readLink(target)).toBe(source);
    }).pipe(Effect.scoped, Effect.provide(supportLayers(calls)));
  },
);

it.effect("does NOT snapshot on a routine update — both olds and output recorded", () => {
  const calls = { count: 0 };
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "link");
    const source1 = path.join(dir, "source1");
    const source2 = path.join(dir, "source2");
    yield* fs.writeFileString(source1, "v1");
    yield* fs.writeFileString(source2, "v2");

    const firstOutput = yield* reconcile({ path: target, source: source1 }, undefined, undefined);
    expect(calls.count).toBe(1);

    // A routine change: both `olds` and `output` are this resource's own
    // prior run — not adoption, not a first apply.
    yield* reconcile(
      { path: target, source: source2 },
      { path: target, source: source1 },
      firstOutput,
    );

    expect(calls.count).toBe(1);
    expect(yield* fs.readLink(target)).toBe(source2);
  }).pipe(Effect.scoped, Effect.provide(supportLayers(calls)));
});

it.effect("does not snapshot at all when the update is a no-op", () => {
  const calls = { count: 0 };
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "link");
    const source = path.join(dir, "source");
    yield* fs.writeFileString(source, "reviewed content");

    const firstOutput = yield* reconcile({ path: target, source }, undefined, undefined);
    expect(calls.count).toBe(1);

    yield* reconcile({ path: target, source }, { path: target, source }, firstOutput);

    expect(calls.count).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(supportLayers(calls)));
});
