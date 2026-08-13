import { expandHome, MachinePaths, MachinePathsLive } from "@machine-run/core";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import {
  makeSymlinkReconciler,
  SymlinkPathUnreadable,
  SymlinkSourceMissing,
} from "../src/Symlink.ts";

const layer = MachinePathsLive().pipe(Layer.provideMerge(NodeServices.layer));

const applyCtx = {
  exec: () => Effect.die("not used"),
  snapshot: () => Effect.succeed(undefined),
};
const observeCtx = { exec: () => Effect.die("not used") };

/**
 * A `MachinePaths` whose home is a fixed temp directory, so `~/x` resolves
 * predictably in a test without touching the real user's home directory.
 * Built from the same `expandHome` the live service uses, so the behaviour
 * under test is the real normalisation logic, not a re-implementation of it.
 */
const withHome = (home: string, path: Path.Path) =>
  Layer.succeed(MachinePaths, {
    home,
    expand: (target: string) => expandHome(path, target, home),
  });

it.effect(
  "a dangling symlink (target deleted) is replaced on apply rather than failing EEXIST",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeSymlinkReconciler;
      const dir = yield* fs.makeTempDirectoryScoped();

      const goneTarget = path.join(dir, "deleted-source");
      const linkPath = path.join(dir, "link");
      // `fs.exists` follows symlinks and reports `false` for a dangling one —
      // this is exactly the state that used to make `apply` call `fs.symlink`
      // straight into an occupied path and fail with `EEXIST`.
      yield* fs.symlink(goneTarget, linkPath);

      const realSource = path.join(dir, "real-source");
      yield* fs.writeFileString(realSource, "reviewed content");

      const props = { path: linkPath, source: realSource };
      const desired = yield* reconciler.desired(props);
      const result = yield* reconciler.apply(
        { props, observed: undefined, desired },
        applyCtx,
      );

      expect(result.source).toBe(realSource);
      expect(yield* fs.readLink(linkPath)).toBe(realSource);
    }).pipe(Effect.provide(layer)),
);

it.effect("apply replaces a real, non-symlink file occupying the path", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeSymlinkReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();

    const target = path.join(dir, "target");
    yield* fs.writeFileString(target, "hand-written, not a symlink");

    const realSource = path.join(dir, "real-source");
    yield* fs.writeFileString(realSource, "reviewed content");

    const props = { path: target, source: realSource };

    // A real file at the path is not this resource's state — there is no
    // symlink to report on, so `observe` reports absent rather than
    // fabricating something from a file it doesn't own.
    const observed = yield* reconciler.observe(props, observeCtx);
    expect(observed).toBeUndefined();

    const desired = yield* reconciler.desired(props);
    yield* reconciler.apply({ props, observed: undefined, desired }, applyCtx);

    expect(yield* fs.readLink(target)).toBe(realSource);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "observe fails with SymlinkPathUnreadable, not absence, when the path cannot be inspected",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeSymlinkReconciler;
      const dir = yield* fs.makeTempDirectoryScoped();

      const blocked = path.join(dir, "blocked");
      yield* fs.makeDirectory(blocked);
      const target = path.join(blocked, "link");
      yield* fs.writeFileString(target, "");
      // Denies both `readLink` and the follow-up `stat` with EACCES rather
      // than ENOENT — the case that must not be folded into "nothing here".
      yield* fs.chmod(blocked, 0o000);

      // Permissions are restored with `Effect.ensuring` rather than a
      // `finally` block, so the restore still runs if the assertion fails or
      // the fiber is interrupted — a `finally` only covers the former.
      const error = yield* reconciler
        .observe({ path: target, source: "/irrelevant" }, observeCtx)
        .pipe(
          Effect.flip,
          Effect.ensuring(fs.chmod(blocked, 0o755).pipe(Effect.orElseSucceed(() => undefined))),
        );
      expect(error).toBeInstanceOf(SymlinkPathUnreadable);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "`~/x`, an absolute path, and an absolute path with a trailing slash all compare equal",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();

      const reconciler = yield* makeSymlinkReconciler.pipe(
        Effect.provide(withHome(home, path)),
      );

      const realSource = path.join(home, "vault");
      yield* fs.writeFileString(realSource, "reviewed content");

      // The link is created via a `~`-relative path...
      const tildeProps = { path: "~/link", source: realSource };
      const tildeDesired = yield* reconciler.desired(tildeProps);
      yield* reconciler.apply(
        { props: tildeProps, observed: undefined, desired: tildeDesired },
        applyCtx,
      );

      // ...and a later plan spells both `path` and `source` as absolute
      // paths carrying a trailing slash. Comparing raw strings would report
      // this as drift on every single plan; both sides must normalise
      // through the same `MachinePaths.expand`.
      const absPath = `${path.join(home, "link")}/`;
      const absSource = `${realSource}/`;
      const absDesired = yield* reconciler.desired({ path: absPath, source: absSource });
      const observedAbs = yield* reconciler.observe(
        { path: absPath, source: absSource },
        observeCtx,
      );

      expect(observedAbs).toBeDefined();
      expect(reconciler.matches(observedAbs!, absDesired)).toBe(true);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "apply fails with SymlinkSourceMissing rather than fabricating content when the source doesn't exist",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeSymlinkReconciler;
      const dir = yield* fs.makeTempDirectoryScoped();

      const props = {
        path: path.join(dir, "link"),
        source: path.join(dir, "does-not-exist"),
      };
      const desired = yield* reconciler.desired(props);
      const error = yield* reconciler
        .apply({ props, observed: undefined, desired }, applyCtx)
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(SymlinkSourceMissing);
      expect(yield* fs.exists(props.path)).toBe(false);
    }).pipe(Effect.provide(layer)),
);
