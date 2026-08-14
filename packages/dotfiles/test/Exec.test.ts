import { NodeServices } from "@effect/platform-node";
import { MachinePaths, MachinePathsLive, silentSession } from "@machine-run/core";
import { expect, it } from "@effect/vitest";
import { CommandExecutor, CommandExecutorLive } from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ExecGuardRequired, makeExecReconciler, type ExecProps } from "../src/Exec.ts";

/**
 * A real `CommandExecutor` (spawns actual processes via
 * `ChildProcessSpawner`) rather than a fake, because `Exec`'s whole job is
 * running commands and interpreting their real exit codes — a fake exit code
 * would test the reconciler's plumbing against a fiction of how `sh` behaves,
 * not against `sh`.
 */
const layer = Layer.mergeAll(MachinePathsLive(), CommandExecutorLive()).pipe(
  Layer.provideMerge(NodeServices.layer),
);

/** The observe/apply context every reconciler method needs, wired to the real executor with a non-reporting session — the same shape `toProvider` builds for planning. */
const ctx = Effect.gen(function* () {
  const executor = yield* CommandExecutor;
  return {
    exec: (props: Parameters<typeof executor.run>[0]) => executor.run(props, silentSession),
    snapshot: () => Effect.succeed(undefined),
  };
});

it.effect("observe fails with a typed error when no guard is set", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeExecReconciler;
    const c = yield* ctx;
    const error = yield* reconciler.observe({ command: "true" }, c).pipe(Effect.flip);
    expect(error).toBeInstanceOf(ExecGuardRequired);
  }).pipe(Effect.provide(layer)),
);

it.effect("a `creates` guard reflects whether the path really exists", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeExecReconciler;
    const c = yield* ctx;
    const dir = yield* fs.makeTempDirectoryScoped();
    const marker = path.join(dir, "marker");

    const props: ExecProps = { command: "true", creates: marker };
    expect(yield* reconciler.observe(props, c)).toEqual(Option.some({ satisfied: false }));

    yield* fs.writeFileString(marker, "");
    expect(yield* reconciler.observe(props, c)).toEqual(Option.some({ satisfied: true }));
  }).pipe(Effect.provide(layer)),
);

it.effect("an `unless` guard runs for real and reads its real exit code", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeExecReconciler;
    const c = yield* ctx;

    const notDone: ExecProps = { command: "true", unless: "false" };
    expect(yield* reconciler.observe(notDone, c)).toEqual(Option.some({ satisfied: false }));

    const alreadyDone: ExecProps = { command: "true", unless: "true" };
    expect(yield* reconciler.observe(alreadyDone, c)).toEqual(Option.some({ satisfied: true }));
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "apply runs the command, and the resulting state honestly reflects the guard afterwards",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeExecReconciler;
      const c = yield* ctx;
      const dir = yield* fs.makeTempDirectoryScoped();
      const marker = path.join(dir, "marker");

      const props: ExecProps = {
        command: `touch ${marker}`,
        creates: marker,
      };

      // Not yet converged: the file this command creates does not exist.
      const before = yield* reconciler.observe(props, c);
      expect(before).toEqual(Option.some({ satisfied: false }));
      const desired = yield* reconciler.desired(props);
      expect(reconciler.matches(Option.getOrThrow(before), desired)).toBe(false);

      const after = yield* reconciler.apply({ props, observed: before, desired }, c);
      expect(after).toEqual({ satisfied: true });
      expect(yield* fs.exists(marker)).toBe(true);

      // A second observe (a later plan) now sees convergence, without
      // running the command again — this is the idempotency the guard
      // exists to provide.
      const later = yield* reconciler.observe(props, c);
      expect(reconciler.matches(Option.getOrThrow(later), desired)).toBe(true);
    }).pipe(Effect.provide(layer)),
);

it.effect("a failing command surfaces as a real CommandError, not a guard result", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeExecReconciler;
    const c = yield* ctx;
    const props: ExecProps = { command: "exit 7", unless: "false" };
    const desired = yield* reconciler.desired(props);
    const error = yield* reconciler
      .apply({ props, observed: Option.none(), desired }, c)
      .pipe(Effect.flip);
    expect(error._tag).toBe("CommandError");
  }).pipe(Effect.provide(layer)),
);

it.effect("address keys off `creates` when set, and the command otherwise", () =>
  Effect.gen(function* () {
    const paths = yield* MachinePaths;
    const reconciler = yield* makeExecReconciler;

    expect(reconciler.address({ command: "true", creates: "~/marker" })).toBe(
      paths.expand("~/marker"),
    );

    // No `creates` to key off: two different commands (or the same command
    // in two different working directories) are two different real actions,
    // and must not contend with each other for the lock `toProvider` derives
    // from `address`.
    const a = reconciler.address({ command: "echo a" });
    const b = reconciler.address({ command: "echo b" });
    const aInTmp = reconciler.address({ command: "echo a", cwd: "/tmp" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(aInTmp);
  }).pipe(Effect.provide(layer)),
);

it.effect("matches compares only the guard's satisfaction", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeExecReconciler;
    const desired = yield* reconciler.desired({ command: "true", unless: "true" });
    expect(reconciler.matches({ satisfied: true }, desired)).toBe(true);
    expect(reconciler.matches({ satisfied: false }, desired)).toBe(false);
  }).pipe(Effect.provide(layer)),
);

it.effect("drift is empty exactly when matches is true, and names satisfied with no direction", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeExecReconciler;
    const drift = reconciler.drift;
    if (drift === undefined) return yield* Effect.die("expected drift to be defined");
    const desired = yield* reconciler.desired({ command: "true", unless: "true" });

    expect(reconciler.matches({ satisfied: true }, desired)).toBe(true);
    expect(drift({ satisfied: true }, desired)).toEqual([]);

    expect(reconciler.matches({ satisfied: false }, desired)).toBe(false);
    const fields = drift({ satisfied: false }, desired);
    expect(fields).toEqual([{ field: "satisfied", observed: "false", desired: "true" }]);
    // "Not yet run" isn't a position on an ordered line, unlike a mode.
    expect(fields[0]?.direction).toBeUndefined();
  }).pipe(Effect.provide(layer)),
);
