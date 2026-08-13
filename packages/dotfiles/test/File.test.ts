import { MachinePathsLive } from "@machine-run/core";
import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FilePathUnreadable, makeFileReconciler, type FileProps } from "../src/File.ts";

const layer = Layer.mergeAll(MachinePathsLive(), NodeCrypto.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const applyCtx = {
  exec: () => Effect.die("not used"),
  snapshot: () => Effect.succeed(undefined),
};
const observeCtx = { exec: () => Effect.die("not used") };

/**
 * A path that cannot be inspected is not a path with nothing at it.
 *
 * Folding the two together would let `apply` overwrite a file it could not
 * see, and would replace the error naming the permission problem with
 * whatever the subsequent write happened to fail with.
 */
it.effect(
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
      yield* reconciler.apply({ props, observed: undefined, desired }, applyCtx);

      // Something other than this tool edits the file between plans — the
      // core case a reconciler model exists to catch.
      yield* fs.writeFileString(target, "hand-edited, not what the recipe asked for");

      const observed = yield* reconciler.observe(props, observeCtx);
      expect(observed).toBeDefined();
      // Comparing against a remembered hash instead of the live file would
      // never see this: `observe` must read the disk, not its own history.
      expect(reconciler.matches(observed!, desired)).toBe(false);
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
    const applied = yield* reconciler.apply({ props, observed: undefined, desired }, applyCtx);
    expect(applied.mode).toBe(0o600);

    const info = yield* fs.stat(target);
    expect(Number(info.mode) & 0o777).toBe(0o600);

    // A later recipe pinning a different mode is real drift, not noise.
    const props2: FileProps = { ...props, mode: 0o644 };
    const desired2 = yield* reconciler.desired(props2);
    expect(reconciler.matches(applied, desired2)).toBe(false);

    const applied2 = yield* reconciler.apply(
      { props: props2, observed: applied, desired: desired2 },
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
    expect(observed?.mode).toBe(0o640);
    expect(reconciler.matches(observed!, desired)).toBe(true);

    // Even a very different real mode still satisfies an unconstrained
    // desired state — only a *pinned* mode should ever cause a rewrite.
    yield* fs.chmod(target, 0o755);
    const observedAgain = yield* reconciler.observe(props, observeCtx);
    expect(reconciler.matches(observedAgain!, desired)).toBe(true);
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
      { props: oldProps, observed: undefined, desired: oldDesired },
      applyCtx,
    );

    // The recipe now points at a new path — a distinct address, with
    // nothing observed there yet.
    const newProps: FileProps = { path: newPath, content: "same content" };
    expect(reconciler.address(oldProps)).not.toBe(reconciler.address(newProps));
    const observedAtNew = yield* reconciler.observe(newProps, observeCtx);
    expect(observedAtNew).toBeUndefined();

    yield* reconciler.apply(
      {
        props: newProps,
        observed: undefined,
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
