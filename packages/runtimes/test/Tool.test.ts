import { MachinePathsLive } from "@machine-run/core";
import { NodeServices } from "@effect/platform-node";
import type { ApplyContext, Exec, ObserveContext } from "@machine-run/engine";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  makeRuntimeToolReconciler,
  RuntimeToolMismatch,
  type RuntimeToolProps,
} from "../src/Tool.ts";

const layer = MachinePathsLive().pipe(Layer.provideMerge(NodeServices.layer));

/** Queues one fixture per call — `Runtime.Tool.observe` issues exactly one command against mise. */
const queuedExec = (outputs: readonly string[]): Exec => {
  let i = 0;
  return ((_props) => {
    const stdout = outputs[i] ?? "[]";
    i += 1;
    return Effect.succeed({ exitCode: 0, stdout, stderr: "" });
  }) as Exec;
};

const capturingExec = (
  stdout: string,
  calls: Array<{ command: string; cwd: string | undefined }>,
): Exec =>
  ((props) => {
    calls.push({ command: props.command, cwd: props.cwd });
    return Effect.succeed({ exitCode: 0, stdout, stderr: "" });
  }) as Exec;

const observeCtx = (exec: Exec): ObserveContext => ({ exec });
const applyCtx = (exec: Exec): ApplyContext => ({
  exec,
  snapshot: () => Effect.die("Runtime.Tool never snapshots — snapshotBeforeApply is unset"),
});

/** A `mise ls <tool> --json` fixture with exactly one entry. */
const miseEntry = (version: string, installed: boolean, active: boolean) =>
  JSON.stringify([{ version, installed, active }]);

const props = (overrides: Partial<RuntimeToolProps> = {}): RuntimeToolProps => ({
  manager: "mise",
  tool: "node",
  version: "22",
  ...overrides,
});

it.effect("observe: nothing installed and nothing active reports undefined", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRuntimeToolReconciler;
    const observed = yield* reconciler.observe(props(), observeCtx(queuedExec(["[]"])));
    expect(observed).toBeUndefined();
  }).pipe(Effect.provide(layer)),
);

it.effect("observe: an installed-and-active version satisfying the request is reported as both", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRuntimeToolReconciler;
    const observed = yield* reconciler.observe(
      props({ version: "22" }),
      observeCtx(queuedExec([miseEntry("22.11.0", true, true)])),
    );
    expect(observed).toEqual({
      manager: "mise",
      tool: "node",
      scope: { _tag: "Global" },
      version: "22.11.0",
      installed: true,
      active: true,
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("observe: installed but not active is reported honestly as installed=true, active=false", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRuntimeToolReconciler;
    const observed = yield* reconciler.observe(
      props({ version: "22" }),
      observeCtx(queuedExec([miseEntry("22.11.0", true, false)])),
    );
    expect(observed).toEqual({
      manager: "mise",
      tool: "node",
      scope: { _tag: "Global" },
      version: "22.11.0",
      installed: true,
      active: false,
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("matches: a fuzzy request is satisfied by any installed+active version sharing its prefix", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRuntimeToolReconciler;
    const desired = yield* reconciler.desired(props({ version: "22" }));
    expect(
      reconciler.matches(
        { manager: "mise", tool: "node", scope: { _tag: "Global" }, version: "22.11.0", installed: true, active: true },
        desired,
      ),
    ).toBe(true);
    expect(
      reconciler.matches(
        { manager: "mise", tool: "node", scope: { _tag: "Global" }, version: "20.11.0", installed: true, active: true },
        desired,
      ),
    ).toBe(false);
  }).pipe(Effect.provide(layer)),
);

it.effect("matches: `active: false` in props is satisfied by an installed version that isn't active", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRuntimeToolReconciler;
    const desired = yield* reconciler.desired(props({ version: "22", active: false }));
    expect(
      reconciler.matches(
        { manager: "mise", tool: "node", scope: { _tag: "Global" }, version: "22.11.0", installed: true, active: false },
        desired,
      ),
    ).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("matches: installed=false never matches, even if the recorded version satisfies the request", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRuntimeToolReconciler;
    const desired = yield* reconciler.desired(props({ version: "22" }));
    // The observed shape a drifted asdf pin produces: active names a version
    // that is no longer installed.
    expect(
      reconciler.matches(
        { manager: "mise", tool: "node", scope: { _tag: "Global" }, version: "22.11.0", installed: false, active: true },
        desired,
      ),
    ).toBe(false);
  }).pipe(Effect.provide(layer)),
);

it.effect("apply: installs and activates when nothing was observed", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRuntimeToolReconciler;
    const calls: Array<{ command: string; cwd: string | undefined }> = [];
    const p = props({ version: "22" });
    const desired = yield* reconciler.desired(p);

    // `apply` re-observes at the end — queue the post-install/activate
    // listing as the *last* fixture the exec sees.
    const exec = capturingExec(miseEntry("22.11.0", true, true), calls);
    const result = yield* reconciler.apply({ props: p, observed: undefined, desired }, applyCtx(exec));

    expect(result).toEqual({
      manager: "mise",
      tool: "node",
      scope: { _tag: "Global" },
      version: "22.11.0",
      installed: true,
      active: true,
    });
    expect(calls.map((c) => c.command)).toEqual([
      "mise install node@22",
      "mise use --global --pin -y node@22",
      "mise ls node --json",
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("apply: an already-installed version is only activated, never reinstalled", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRuntimeToolReconciler;
    const calls: Array<{ command: string; cwd: string | undefined }> = [];
    const p = props({ version: "22" });
    const desired = yield* reconciler.desired(p);
    const observed = {
      manager: "mise" as const,
      tool: "node",
      scope: { _tag: "Global" as const },
      version: "22.11.0",
      installed: true,
      active: false,
    };

    const exec = capturingExec(miseEntry("22.11.0", true, true), calls);
    yield* reconciler.apply({ props: p, observed, desired }, applyCtx(exec));

    expect(calls.map((c) => c.command)).toEqual([
      "mise use --global --pin -y node@22",
      "mise ls node --json",
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("apply: `active: false` installs but never calls activate", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRuntimeToolReconciler;
    const calls: Array<{ command: string; cwd: string | undefined }> = [];
    const p = props({ version: "22", active: false });
    const desired = yield* reconciler.desired(p);

    const exec = capturingExec(miseEntry("22.11.0", true, false), calls);
    yield* reconciler.apply({ props: p, observed: undefined, desired }, applyCtx(exec));

    expect(calls.map((c) => c.command)).toEqual(["mise install node@22", "mise ls node --json"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("address: is the manager's shared config file, not the manager id alone", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRuntimeToolReconciler;
    const global = reconciler.address(props({ tool: "node" }));
    const globalOtherTool = reconciler.address(props({ tool: "python" }));
    const scoped = reconciler.address(props({ tool: "node", scope: { _tag: "Directory", path: "/proj" } }));
    // Two different tools activated globally on the same manager contend for
    // the same file, so they share an address.
    expect(global).toBe(globalOtherTool);
    // A directory scope is a different file and does not contend with global.
    expect(scoped).not.toBe(global);
  }).pipe(Effect.provide(layer)),
);

it.effect("rustup/uv reject a `tool` other than the one they fix", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRuntimeToolReconciler;
    const error = yield* reconciler
      .observe(props({ manager: "rustup", tool: "node", version: "1.75.0" }), observeCtx(queuedExec([""])))
      .pipe(Effect.flip);
    expect(error).toBeInstanceOf(RuntimeToolMismatch);
  }).pipe(Effect.provide(layer)),
);
