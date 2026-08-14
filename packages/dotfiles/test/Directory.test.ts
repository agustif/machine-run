import { MachinePathsLive, PlatformFor, PlatformLive } from "@machine-run/core";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import {
  DirectoryPathIsFile,
  makeDirectoryReconciler,
  type DirectoryProps,
} from "../src/Directory.ts";

const layer = Layer.mergeAll(MachinePathsLive(), PlatformLive()).pipe(
  Layer.provideMerge(NodeServices.layer),
);

/** Builds a reconciler and hands it a real temp directory to work in. */
const withTempDir = <A, E>(
  run: (
    reconciler: Effect.Success<typeof makeDirectoryReconciler>,
    dir: string,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const reconciler = yield* makeDirectoryReconciler;
    return yield* run(reconciler, path.join(dir, "sub"));
  });

const props = (path: string, mode?: number): DirectoryProps =>
  mode === undefined ? { path } : { path, mode };

it.effect("observe reports nothing for a directory that does not exist yet", () =>
  withTempDir((reconciler, target) =>
    Effect.gen(function* () {
      const observed = yield* reconciler.observe(props(target), {
        exec: () => Effect.die("not used"),
      });
      expect(observed).toStrictEqual(Option.none());
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("apply creates the directory with the requested mode", () =>
  withTempDir((reconciler, target) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const desired = yield* reconciler.desired(props(target, 0o700));
      const result = yield* reconciler.apply(
        { props: props(target, 0o700), observed: Option.none(), desired },
        { exec: () => Effect.die("not used"), snapshot: () => Effect.succeed(undefined) },
      );
      expect(result.mode).toBe(0o700);

      const info = yield* fs.stat(target);
      expect(info.type).toBe("Directory");
      expect(Number(info.mode) & 0o777).toBe(0o700);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("apply chmods a directory that already exists with a different mode", () =>
  withTempDir((reconciler, target) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // Pre-create the directory at a mode the recipe does not ask for —
      // `mkdir`'s `mode` option only applies at creation, so converging an
      // *existing* directory to a new mode has to be a real code path, not
      // just the happy path where `makeDirectory` does the whole job.
      yield* fs.makeDirectory(target, { recursive: true, mode: 0o755 });

      const desired = yield* reconciler.desired(props(target, 0o700));
      const result = yield* reconciler.apply(
        { props: props(target, 0o700), observed: Option.none(), desired },
        { exec: () => Effect.die("not used"), snapshot: () => Effect.succeed(undefined) },
      );
      expect(result.mode).toBe(0o700);

      const info = yield* fs.stat(target);
      expect(Number(info.mode) & 0o777).toBe(0o700);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("observe fails with a typed error when a file occupies the path", () =>
  withTempDir((reconciler, target) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, "not a directory");

      const error = yield* reconciler
        .observe(props(target), { exec: () => Effect.die("not used") })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(DirectoryPathIsFile);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("matches is satisfied by any mode when the recipe does not constrain one", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeDirectoryReconciler;
    const desired = yield* reconciler.desired({ path: "/tmp/whatever" });
    expect(reconciler.matches({ path: "/tmp/whatever", mode: 0o755 }, desired)).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("matches rejects a mode the recipe does constrain", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeDirectoryReconciler;
    const desired = yield* reconciler.desired({ path: "/tmp/whatever", mode: 0o700 });
    expect(reconciler.matches({ path: "/tmp/whatever", mode: 0o755 }, desired)).toBe(false);
    expect(reconciler.matches({ path: "/tmp/whatever", mode: 0o700 }, desired)).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("drift is empty exactly when matches is true, and names mode with a direction", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeDirectoryReconciler;
    const drift = reconciler.drift;
    if (drift === undefined) return yield* Effect.die("expected drift to be defined");

    const desired = yield* reconciler.desired({ path: "/tmp/whatever", mode: 0o700 });
    const satisfied = { path: "/tmp/whatever", mode: 0o700 };
    expect(reconciler.matches(satisfied, desired)).toBe(true);
    expect(drift(satisfied, desired)).toEqual([]);

    const looser = { path: "/tmp/whatever", mode: 0o755 };
    expect(reconciler.matches(looser, desired)).toBe(false);
    expect(drift(looser, desired)).toEqual([
      { field: "mode", observed: "755", desired: "700", direction: "ahead" },
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("unapply removes the directory it created, when it's still empty", () =>
  withTempDir((reconciler, target) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const unapply = reconciler.unapply;
      if (unapply === undefined) return yield* Effect.die("expected unapply to be defined");
      const desired = yield* reconciler.desired(props(target));
      yield* reconciler.apply(
        { props: props(target), observed: Option.none(), desired },
        { exec: () => Effect.die("not used"), snapshot: () => Effect.succeed(undefined) },
      );

      yield* unapply(
        { props: props(target), observed: desired, recorded: desired },
        { exec: () => Effect.die("not used"), snapshot: () => Effect.succeed(undefined) },
      );

      expect(yield* fs.exists(target)).toBe(false);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect(
  "unapply leaves a non-empty directory alone — it owns the directory, never its contents",
  () =>
    withTempDir((reconciler, target) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const unapply = reconciler.unapply;
        if (unapply === undefined) return yield* Effect.die("expected unapply to be defined");
        const desired = yield* reconciler.desired(props(target));
        yield* reconciler.apply(
          { props: props(target), observed: Option.none(), desired },
          { exec: () => Effect.die("not used"), snapshot: () => Effect.succeed(undefined) },
        );

        // Something else placed a file inside it after creation.
        yield* fs.writeFileString(path.join(target, "placed-by-something-else"), "x");

        yield* unapply(
          { props: props(target), observed: desired, recorded: desired },
          { exec: () => Effect.die("not used"), snapshot: () => Effect.succeed(undefined) },
        );

        expect(yield* fs.exists(target)).toBe(true);
      }),
    ).pipe(Effect.provide(layer)),
);

/**
 * The Windows branch, exercised from a Mac by providing `Platform` as `win32`.
 *
 * This is the whole reason `Platform` is a service rather than a
 * `process.platform` read: without it the branch that decides whether a mode is
 * satisfied on Windows could only be tested on Windows, which is where it was
 * silently failing 4 of this file's tests before.
 *
 * The listing is the `icacls` shape `packages/core/test/windows/Icacls.test.ts`
 * pins — owner-only rights, which is what 0o700 intends.
 */
const OWNER_ONLY_ACL =
  "C:\\data OWNER RIGHTS:(RD,REA,RA,RC,S,WD,AD,WEA,WA)\n\nSuccessfully processed 1 files; Failed processing 0 files\n";

const windowsLayer = Layer.mergeAll(MachinePathsLive(), PlatformFor("win32")).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.effect("on Windows a mode is satisfied by the ACL, not by comparing mode bits", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeDirectoryReconciler;
    const desired = { path: "C:\\data", mode: 0o700 };

    // Node reports 0o666 for every directory on Windows, so mode equality can
    // never hold — this is exactly the comparison that reported drift forever.
    const withAcl = { path: "C:\\data", mode: 0o666, acl: OWNER_ONLY_ACL };
    expect(reconciler.matches(withAcl, desired)).toBe(true);

    // An ACL that could not be read is "cannot confirm", which must converge by
    // re-applying rather than by assuming satisfaction.
    const withoutAcl = { path: "C:\\data", mode: 0o666 };
    expect(reconciler.matches(withoutAcl, desired)).toBe(false);

    // A broader ACL is real drift.
    const broadened = {
      path: "C:\\data",
      mode: 0o666,
      acl: OWNER_ONLY_ACL.replace("OWNER RIGHTS:(RD", "Everyone:(WD,AD)\nC:\\data OWNER RIGHTS:(RD"),
    };
    expect(reconciler.matches(broadened, desired)).toBe(false);
  }).pipe(Effect.provide(windowsLayer)),
);

it.effect("an unconstrained mode is satisfied on Windows without consulting any ACL", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeDirectoryReconciler;
    expect(reconciler.matches({ path: "C:\\data", mode: 0o666 }, { path: "C:\\data" })).toBe(true);
  }).pipe(Effect.provide(windowsLayer)),
);
