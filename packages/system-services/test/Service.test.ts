import type { CommandError } from "alchemy/Command";
import { expandHome, MachinePaths, MachinePathsLive } from "@machine-run/core";
import { NodeServices } from "@effect/platform-node";
import type { ApplyContext, Exec, ObserveContext } from "@machine-run/engine";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { makeServiceReconciler, ServiceNotConverged, type ServiceProps } from "../src/Service.ts";

const layer = MachinePathsLive().pipe(Layer.provideMerge(NodeServices.layer));

/** A `MachinePaths` whose home is a fixed temp directory — same pattern as `dotfiles/test/Symlink.test.ts`. */
const withHome = (home: string, path: Path.Path) =>
  Layer.succeed(MachinePaths, {
    home,
    expand: (target: string) => expandHome(path, target, home),
  });

/** A queued `Exec` fake and the commands it was actually asked to run. */
interface QueuedExec {
  readonly exec: Exec;
  readonly calls: string[];
}

/** Queues one stdout string per call, in order. */
const queuedExec = (outputs: readonly string[]): QueuedExec => {
  const calls: string[] = [];
  let i = 0;
  const exec: Exec = (props) => {
    calls.push(props.command);
    const stdout = outputs[i] ?? "";
    i += 1;
    return Effect.succeed({ exitCode: 0, stdout, stderr: "" });
  };
  return { exec, calls };
};

const failingExec =
  (exitCode: number, stderr: string): Exec =>
  (props) =>
    Effect.fail({
      _tag: "CommandError" as const,
      // Widened to plain `string`: `CommandError` (a real Alchemy class) has
      // no `ShellCommand` field to overlap with, so keeping the brand here
      // would make this fake object incomparable to it.
      command: String(props.command),
      reason: { _tag: "UnexpectedExit" as const, exitCode, stderr, message: stderr },
      message: `Failed to execute command "${props.command}": ${stderr}`,
    } as CommandError);

const observeCtx = (exec: Exec): ObserveContext => ({ exec });
const applyCtx = (exec: Exec): ApplyContext => ({
  exec,
  snapshot: () => Effect.die("System.Service never snapshots — snapshotBeforeApply is unset"),
});

const brewInfo = (registered: boolean, loaded: boolean, running: boolean): string =>
  JSON.stringify([{ registered, loaded, running }]);

const props = (overrides: Partial<ServiceProps> = {}): ServiceProps => ({
  backend: "brew-services",
  name: "thing",
  ...overrides,
});

it.effect("address is backend:name, so two Services naming the same pair contend", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeServiceReconciler;
    expect(reconciler.address(props({ backend: "brew-services", name: "thing" }))).toBe(
      "brew-services:thing",
    );
    expect(reconciler.address(props({ backend: "launchd", name: "com.example.thing" }))).toBe(
      "launchd:com.example.thing",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("desired: enabled and running default to true; installed is always requested true", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeServiceReconciler;
    const desired = yield* reconciler.desired(props());
    expect(desired).toEqual({
      backend: "brew-services",
      name: "thing",
      installed: true,
      enabled: true,
      running: true,
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("desired: enabled and running can each be pinned false independently", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeServiceReconciler;
    const desired = yield* reconciler.desired(props({ enabled: true, running: false }));
    expect(desired.enabled).toBe(true);
    expect(desired.running).toBe(false);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "matches: true iff backend, name, enabled and running all agree — installed is not compared",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeServiceReconciler;
      const desired = {
        backend: "brew-services" as const,
        name: "thing",
        installed: true,
        enabled: true,
        running: true,
      };
      // Same enabled/running, but the definition file happens to be gone —
      // still matches, since a fully-off request doesn't compare `installed`
      // and this request isn't fully off, but `installed` is excluded either
      // way — see `Service.ts`'s doc comment.
      expect(reconciler.matches({ ...desired, installed: false }, desired)).toBe(true);
      expect(reconciler.matches({ ...desired, enabled: false }, desired)).toBe(false);
      expect(reconciler.matches({ ...desired, running: false }, desired)).toBe(false);
      expect(reconciler.matches({ ...desired, name: "other" }, desired)).toBe(false);
      expect(reconciler.matches({ ...desired, backend: "launchd" }, desired)).toBe(false);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "observe: never returns Option.none() — a fully absent service is a defined, all-false state",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeServiceReconciler;
      // Real captured `brew services info transmission-cli --json` shape (see
      // `test/backends.test.ts`), never started on this machine.
      const observed = yield* reconciler.observe(
        props({ name: "transmission-cli" }),
        observeCtx(queuedExec([brewInfo(false, false, false)]).exec),
      );
      expect(observed).toEqual(
        Option.some({
          backend: "brew-services",
          name: "transmission-cli",
          installed: false,
          enabled: false,
          running: false,
        }),
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "apply: converges brew-services to (enabled: true, running: true) via a single `start`",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeServiceReconciler;
      const p = props({ name: "thing" });
      const desired = yield* reconciler.desired(p);
      const { exec, calls } = queuedExec([
        "", // `brew services start thing`
        brewInfo(true, true, true), // the re-observe `brew services info thing --json`
      ]);

      const result = yield* reconciler.apply(
        { props: p, observed: Option.none(), desired },
        applyCtx(exec),
      );

      expect(result).toEqual({
        backend: "brew-services",
        name: "thing",
        installed: true,
        enabled: true,
        running: true,
      });
      expect(calls).toEqual(["brew services start thing", "brew services info thing --json"]);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "apply: fails loudly with ServiceNotConverged when a fresh observation disagrees with what was requested",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeServiceReconciler;
      const p = props({ name: "thing" });
      const desired = yield* reconciler.desired(p);
      const { exec } = queuedExec([
        "", // `brew services start thing` "succeeds"
        brewInfo(false, false, false), // but a fresh read still shows it off
      ]);

      const result = yield* Effect.flip(
        reconciler.apply({ props: p, observed: Option.none(), desired }, applyCtx(exec)),
      );

      expect(result).toBeInstanceOf(ServiceNotConverged);
      expect(result).toMatchObject({
        backend: "brew-services",
        name: "thing",
        expectedEnabled: true,
        expectedRunning: true,
        actualEnabled: false,
        actualRunning: false,
      });
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "launchd end-to-end through the full reconciler: a plist at the conventional path is reported installed",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const agentsDir = path.join(home, "Library", "LaunchAgents");
      yield* fs.makeDirectory(agentsDir, { recursive: true });
      yield* fs.writeFileString(path.join(agentsDir, "com.example.thing.plist"), "<plist/>");

      const reconciler = yield* makeServiceReconciler.pipe(Effect.provide(withHome(home, path)));

      // Real captured shape: a label launchd has never loaded exits 113 with
      // this stderr — see `test/backends.test.ts`.
      const observed = yield* reconciler.observe(
        props({ backend: "launchd", name: "com.example.thing" }),
        observeCtx(
          failingExec(113, `Could not find service "com.example.thing" in domain for port\n`),
        ),
      );
      expect(observed).toEqual(
        Option.some({
          backend: "launchd",
          name: "com.example.thing",
          installed: true,
          enabled: false,
          running: false,
        }),
      );
    }).pipe(Effect.provide(layer)),
);
