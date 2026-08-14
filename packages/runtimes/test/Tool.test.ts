import { MachinePathsLive, PlatformLive } from "@machine-run/core";
import { NodeServices } from "@effect/platform-node";
import type { ApplyContext, Exec, ObserveContext } from "@machine-run/engine";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { RuntimeScope } from "../src/Backend.ts";
import {
  makeRuntimeToolReconciler,
  type RuntimeToolProps,
  type RuntimeToolState,
} from "../src/Tool.ts";

const layer = Layer.mergeAll(MachinePathsLive(), PlatformLive(), PlatformLive()).pipe(Layer.provideMerge(NodeServices.layer));

/** Queues one fixture per call — `Runtime.Tool.observe` issues exactly one command against mise. */
const queuedExec = (outputs: readonly string[]): Exec => {
  let i = 0;
  return () => {
    const stdout = outputs[i] ?? "[]";
    i += 1;
    return Effect.succeed({ exitCode: 0, stdout, stderr: "" });
  };
};

const capturingExec = (
  stdout: string,
  calls: Array<{ command: string; cwd: string | undefined }>,
): Exec =>
  (props) => {
    calls.push({ command: props.command, cwd: props.cwd });
    return Effect.succeed({ exitCode: 0, stdout, stderr: "" });
  };

const observeCtx = (exec: Exec): ObserveContext => ({ exec });
const applyCtx = (exec: Exec): ApplyContext => ({
  exec,
  snapshot: () => Effect.die("Runtime.Tool never snapshots — snapshotBeforeApply is unset"),
});

/** A `mise ls <tool> --json` fixture with exactly one entry. */
const miseEntry = (version: string, installed: boolean, active: boolean) =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Json))([{ version, installed, active }]);

const props = (
  overrides: Partial<Extract<RuntimeToolProps, { _tag: "Mise" }>> = {},
): RuntimeToolProps => ({
  _tag: "Mise",
  tool: "node",
  version: "22",
  ...overrides,
});

it.effect("observe: nothing installed and nothing active reports Option.none()", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRuntimeToolReconciler;
    const observed = yield* reconciler.observe(props(), observeCtx(queuedExec(["[]"])));
    expect(observed).toEqual(Option.none());
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "observe: an installed-and-active version satisfying the request is reported as both",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeRuntimeToolReconciler;
      const observed = yield* reconciler.observe(
        props({ version: "22" }),
        observeCtx(queuedExec([miseEntry("22.11.0", true, true)])),
      );
      expect(observed).toEqual(
        Option.some({
          manager: "Mise",
          tool: "node",
          scope: { _tag: "Global" },
          version: "22.11.0",
          installed: true,
          active: true,
        }),
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "observe: installed but not active is reported honestly as installed=true, active=false",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeRuntimeToolReconciler;
      const observed = yield* reconciler.observe(
        props({ version: "22" }),
        observeCtx(queuedExec([miseEntry("22.11.0", true, false)])),
      );
      expect(observed).toEqual(
        Option.some({
          manager: "Mise",
          tool: "node",
          scope: { _tag: "Global" },
          version: "22.11.0",
          installed: true,
          active: false,
        }),
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "matches: a fuzzy request is satisfied by any installed+active version sharing its prefix",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeRuntimeToolReconciler;
      const desired = yield* reconciler.desired(props({ version: "22" }));
      expect(
        reconciler.matches(
          {
            manager: "Mise",
            tool: "node",
            scope: { _tag: "Global" },
            version: "22.11.0",
            installed: true,
            active: true,
          },
          desired,
        ),
      ).toBe(true);
      expect(
        reconciler.matches(
          {
            manager: "Mise",
            tool: "node",
            scope: { _tag: "Global" },
            version: "20.11.0",
            installed: true,
            active: true,
          },
          desired,
        ),
      ).toBe(false);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "matches: `active: false` in props is satisfied by an installed version that isn't active",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeRuntimeToolReconciler;
      const desired = yield* reconciler.desired(props({ version: "22", active: false }));
      expect(
        reconciler.matches(
          {
            manager: "Mise",
            tool: "node",
            scope: { _tag: "Global" },
            version: "22.11.0",
            installed: true,
            active: false,
          },
          desired,
        ),
      ).toBe(true);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "matches: installed=false never matches, even if the recorded version satisfies the request",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeRuntimeToolReconciler;
      const desired = yield* reconciler.desired(props({ version: "22" }));
      // The observed shape a drifted asdf pin produces: active names a version
      // that is no longer installed.
      expect(
        reconciler.matches(
          {
            manager: "Mise",
            tool: "node",
            scope: { _tag: "Global" },
            version: "22.11.0",
            installed: false,
            active: true,
          },
          desired,
        ),
      ).toBe(false);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "matches: a different manager, or a different tool on the same manager, never matches",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeRuntimeToolReconciler;
      const desired = yield* reconciler.desired(props({ tool: "node", version: "22" }));
      const globalScope: RuntimeScope = { _tag: "Global" };
      const observedBase: Omit<RuntimeToolState, "manager" | "tool"> = {
        scope: globalScope,
        version: "22.11.0",
        installed: true,
        active: true,
      };
      // Same manager, different tool.
      expect(
        reconciler.matches({ manager: "Mise", tool: "python", ...observedBase }, desired),
      ).toBe(false);
      // Same tool name, different manager (asdf spells node "nodejs", so this
      // also covers the case of a same-named tool under the wrong manager).
      expect(reconciler.matches({ manager: "Asdf", tool: "node", ...observedBase }, desired)).toBe(
        false,
      );
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
    const result = yield* reconciler.apply(
      { props: p, observed: Option.none(), desired },
      applyCtx(exec),
    );

    expect(result).toEqual({
      manager: "Mise",
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
    const observed: RuntimeToolState = {
      manager: "Mise",
      tool: "node",
      scope: { _tag: "Global" },
      version: "22.11.0",
      installed: true,
      active: false,
    };

    const exec = capturingExec(miseEntry("22.11.0", true, true), calls);
    yield* reconciler.apply({ props: p, observed: Option.some(observed), desired }, applyCtx(exec));

    expect(calls.map((c) => c.command)).toEqual([
      "mise use --global --pin -y node@22",
      "mise ls node --json",
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "apply: an installed version under a different tool/manager is not mistaken for the same one",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeRuntimeToolReconciler;
      const calls: Array<{ command: string; cwd: string | undefined }> = [];
      const p = props({ tool: "node", version: "22" });
      const desired = yield* reconciler.desired(p);
      // Same manager, satisfies the version request, but names a different
      // tool — `sameIdentity` must reject this, or `apply` would skip
      // `install` for a tool it never actually installed.
      const observed: RuntimeToolState = {
        manager: "Mise",
        tool: "python",
        scope: { _tag: "Global" },
        version: "22.11.0",
        installed: true,
        active: true,
      };

      const exec = capturingExec(miseEntry("22.11.0", true, true), calls);
      yield* reconciler.apply(
        { props: p, observed: Option.some(observed), desired },
        applyCtx(exec),
      );

      expect(calls.map((c) => c.command)).toEqual([
        "mise install node@22",
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
    yield* reconciler.apply({ props: p, observed: Option.none(), desired }, applyCtx(exec));

    expect(calls.map((c) => c.command)).toEqual(["mise install node@22", "mise ls node --json"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("drift: empty exactly when matches is true", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRuntimeToolReconciler;
    const desired = yield* reconciler.desired(props({ version: "22" }));
    const observed: RuntimeToolState = {
      manager: "Mise",
      tool: "node",
      scope: { _tag: "Global" },
      version: "22.11.0",
      installed: true,
      active: true,
    };
    expect(reconciler.matches(observed, desired)).toBe(true);
    expect(reconciler.drift?.(observed, desired)).toEqual([]);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "drift: a version behind the request reports \"version\" with direction \"behind\"",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeRuntimeToolReconciler;
      const desired = yield* reconciler.desired(props({ version: "22.11.0" }));
      const observed: RuntimeToolState = {
        manager: "Mise",
        tool: "node",
        scope: { _tag: "Global" },
        version: "22.9.5",
        installed: true,
        active: true,
      };
      expect(reconciler.matches(observed, desired)).toBe(false);
      const drift = reconciler.drift?.(observed, desired) ?? [];
      expect(drift).toContainEqual({
        field: "version",
        observed: "22.9.5",
        desired: "22.11.0",
        direction: "behind",
      });
    }).pipe(Effect.provide(layer)),
);

it.effect("drift: a rustup channel mismatch reports \"version\" with no direction", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRuntimeToolReconciler;
    const desired = yield* reconciler.desired({ _tag: "Rustup", channel: "stable" });
    const observed: RuntimeToolState = {
      manager: "Rustup",
      scope: { _tag: "Global" },
      version: "beta",
      installed: true,
      active: true,
    };
    expect(reconciler.matches(observed, desired)).toBe(false);
    const drift = reconciler.drift?.(observed, desired) ?? [];
    expect(drift).toContainEqual({ field: "version", observed: "beta", desired: "stable" });
    expect(drift.find((f) => f.field === "version")?.direction).toBeUndefined();
  }).pipe(Effect.provide(layer)),
);

it.effect("drift: `active: false` in props never reports \"active\", even when observed isn't", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRuntimeToolReconciler;
    const desired = yield* reconciler.desired(props({ version: "22", active: false }));
    const observed: RuntimeToolState = {
      manager: "Mise",
      tool: "node",
      scope: { _tag: "Global" },
      version: "22.11.0",
      installed: true,
      active: false,
    };
    expect(reconciler.matches(observed, desired)).toBe(true);
    expect(reconciler.drift?.(observed, desired)).toEqual([]);
  }).pipe(Effect.provide(layer)),
);

it.effect("Runtime.Tool has no unapply: uninstalling could strand activation at a missing version", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRuntimeToolReconciler;
    expect(reconciler.unapply).toBeUndefined();
  }).pipe(Effect.provide(layer)),
);

it.effect("address: is the manager's shared config file, not the manager id alone", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRuntimeToolReconciler;
    const global = reconciler.address(props({ tool: "node" }));
    const globalOtherTool = reconciler.address(props({ tool: "python" }));
    const scoped = reconciler.address(
      props({ tool: "node", scope: { _tag: "Directory", path: "/proj" } }),
    );
    // Two different tools activated globally on the same manager contend for
    // the same file, so they share an address.
    expect(global).toBe(globalOtherTool);
    // A directory scope is a different file and does not contend with global.
    expect(scoped).not.toBe(global);
  }).pipe(Effect.provide(layer)),
);

it.effect("rustup has no `tool` field to get wrong, and a `channel` request works end to end", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRuntimeToolReconciler;
    // Real captured `rustup show` shape (see `test/backends.test.ts`), abridged
    // to just enough to satisfy a "stable" request.
    const rustupShow = `Default host: aarch64-apple-darwin
rustup home:  /Users/a/.rustup

installed toolchains
--------------------
stable-aarch64-apple-darwin (active, default)

active toolchain
----------------
name: stable-aarch64-apple-darwin
active because: it's the default toolchain
installed targets:
  aarch64-apple-darwin
`;
    const observed = yield* reconciler.observe(
      { _tag: "Rustup", channel: "stable" },
      observeCtx(queuedExec([rustupShow])),
    );
    expect(observed).toEqual(
      Option.some({
        manager: "Rustup",
        scope: { _tag: "Global" },
        version: "stable",
        installed: true,
        active: true,
      }),
    );
  }).pipe(Effect.provide(layer)),
);
