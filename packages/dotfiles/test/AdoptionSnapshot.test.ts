import { Backups, FileLockLive, MachinePathsLive, silentSession } from "@machine-run/core";
import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { toProvider } from "@machine-run/engine";
import { expect, it } from "@effect/vitest";
import { CommandExecutor } from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { File, makeFileReconciler, type FileProps, type FileState } from "../src/File.ts";

/**
 * Proves the adoption-backup gate documented on `Reconciler.snapshotBeforeApply`
 * and implemented in `toProvider`'s generated `reconcile` — not in
 * `Machine.File` itself: a snapshot is taken on a resource's true first apply
 * and on the first apply after adopting something already present, but never
 * on a routine update or a no-op. The brief for this task notes the gate "was
 * silently broken once", so it is exercised end-to-end through the real
 * `File.Provider` (the same way `packages/engine/test/unapply.test.ts` proves
 * the neighbouring `delete`/`unapply` wiring), rather than by calling
 * `makeFileReconciler`'s methods directly — the thing under test is one level
 * up from the reconciler.
 *
 * `Machine.File` is the vehicle because it is the one resource in this
 * package that sets `snapshotBeforeApply: true` and never calls
 * `ctx.snapshot` itself, so every snapshot observed here came from the
 * engine's own `preexisting` gate, not from the resource.
 */
const CommandExecutorStub = Layer.succeed(CommandExecutor, {
  spawn: () => Effect.die("Machine.File never runs a command"),
  run: () => Effect.die("Machine.File never runs a command"),
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

/** Everything `toProvider(File, ...)` and the test body itself need, with `Backups` faked so snapshot calls are countable. */
const supportLayers = (calls: { count: number }) =>
  Layer.mergeAll(CommandExecutorStub, FileLockLive(), NodeCrypto.layer, fakeBackups(calls)).pipe(
    Layer.provideMerge(MachinePathsLive()),
    Layer.provideMerge(NodeServices.layer),
  );

const reconcile = (news: FileProps, olds: FileProps | undefined, output: FileState | undefined) =>
  Effect.gen(function* () {
    const provider = yield* File.Provider;
    return yield* provider.reconcile({
      id: "f",
      fqn: "f",
      instanceId: "f",
      news,
      olds,
      output,
      session: silentSession,
      bindings: [],
    });
  }).pipe(Effect.provide(toProvider(File, makeFileReconciler)));

it.effect("snapshots on a true first apply — nothing recorded yet", () => {
  const calls = { count: 0 };
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "config");

    yield* reconcile({ path: target, content: "generated" }, undefined, undefined);

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
      const target = path.join(dir, "config");
      yield* fs.writeFileString(target, "hand-written before machine-run ever ran");

      // `read` adopted this file on some earlier plan (`output` is
      // populated), but this is the first `reconcile` this resource has
      // ever gone through — `olds`, the previously recorded props, is
      // still undefined.
      yield* reconcile({ path: target, content: "generated" }, undefined, {
        path: target,
        hash: "stale-hash-from-adoption",
      });

      expect(calls.count).toBe(1);
      expect(yield* fs.readFileString(target)).toBe("generated");
    }).pipe(Effect.scoped, Effect.provide(supportLayers(calls)));
  },
);

it.effect("does NOT snapshot on a routine update — both olds and output recorded", () => {
  const calls = { count: 0 };
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "config");

    const firstOutput = yield* reconcile({ path: target, content: "v1" }, undefined, undefined);
    expect(calls.count).toBe(1);

    // A routine content change: both `olds` and `output` are this
    // resource's own prior run — not adoption, not a first apply.
    yield* reconcile({ path: target, content: "v2" }, { path: target, content: "v1" }, firstOutput);

    expect(calls.count).toBe(1);
    expect(yield* fs.readFileString(target)).toBe("v2");
  }).pipe(Effect.scoped, Effect.provide(supportLayers(calls)));
});

it.effect("does not snapshot at all when the update is a no-op", () => {
  const calls = { count: 0 };
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "config");

    const firstOutput = yield* reconcile({ path: target, content: "v1" }, undefined, undefined);
    expect(calls.count).toBe(1);

    yield* reconcile({ path: target, content: "v1" }, { path: target, content: "v1" }, firstOutput);

    expect(calls.count).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(supportLayers(calls)));
});
