import { MachinePaths, MachinePathsLive } from "@machine-run/core";
import type { McpServerProps } from "@machine-run/ai";
import { makeMcpServerReconciler } from "@machine-run/ai";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

/**
 * Effect's default `ConfigProvider` snapshots `process.env` on its first
 * read and never refreshes that snapshot for the lifetime of the process —
 * verified directly, since it is easy to assume `Config.redacted` reads
 * live. Mutating `process.env` mid-test is therefore not a reliable way to
 * simulate "the secret store's value changed"; providing a fresh, in-memory
 * `ConfigProvider` per test is.
 */
const envConfig = (vars: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromEnvRecord(vars));

const layer = MachinePathsLive().pipe(Layer.provideMerge(NodeServices.layer));

const observeCtx = { exec: () => Effect.die("claude backend never calls exec") };
const applyCtx = {
  exec: () => Effect.die("claude backend never calls exec"),
  snapshot: () => Effect.succeed(undefined),
};

/**
 * A `MachinePaths` whose home is a fixed temp directory, the same pattern
 * `dotfiles/test/Symlink.test.ts` uses — the Claude backend reads/writes
 * `<home>/.claude.json`, so tests need a real, disposable home rather than
 * touching the operator's own `~/.claude.json`.
 */
const withHome = (home: string) =>
  Layer.succeed(MachinePaths, {
    home,
    expand: (target: string) => (target === "~" ? home : target.replace(/^~\//, `${home}/`)),
  });

it.effect("apply registers a stdio server, and a later observe reports it as matching", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    const reconciler = yield* makeMcpServerReconciler.pipe(Effect.provide(withHome(home)));

    const props: McpServerProps = {
      tool: "claude",
      name: "my-server",
      command: "npx",
      args: ["-y", "my-mcp-server"],
      env: { LOG_LEVEL: "debug" },
    };
    const desired = yield* reconciler.desired(props);
    yield* reconciler.apply({ props, observed: undefined, desired }, applyCtx);

    const observed = yield* reconciler.observe(props, observeCtx);
    expect(observed).toBeDefined();
    expect(reconciler.matches(observed!, desired)).toBe(true);

    const written = JSON.parse(yield* fs.readFileString(path.join(home, ".claude.json")));
    expect(written.mcpServers["my-server"]).toEqual({
      command: "npx",
      args: ["-y", "my-mcp-server"],
      env: { LOG_LEVEL: "debug" },
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("changing a literal env value is real drift, caught by matches and fixed by apply", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    const reconciler = yield* makeMcpServerReconciler.pipe(Effect.provide(withHome(home)));

    const props: McpServerProps = {
      tool: "claude",
      name: "my-server",
      command: "npx",
      env: { LOG_LEVEL: "debug" },
    };
    const desired = yield* reconciler.desired(props);
    yield* reconciler.apply({ props, observed: undefined, desired }, applyCtx);

    const changedProps: McpServerProps = { ...props, env: { LOG_LEVEL: "trace" } };
    const changedDesired = yield* reconciler.desired(changedProps);
    const observed = yield* reconciler.observe(props, observeCtx);
    expect(reconciler.matches(observed!, changedDesired)).toBe(false);

    yield* reconciler.apply(
      { props: changedProps, observed, desired: changedDesired },
      applyCtx,
    );
    const written = JSON.parse(yield* fs.readFileString(path.join(home, ".claude.json")));
    expect(written.mcpServers["my-server"].env).toEqual({ LOG_LEVEL: "trace" });
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a secret-sourced env value is resolved and written to disk, but never persisted in props, desired, or observed state",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const reconciler = yield* makeMcpServerReconciler.pipe(Effect.provide(withHome(home)));

      const props: McpServerProps = {
        tool: "claude",
        name: "my-server",
        command: "npx",
        env: { API_KEY: { source: "env", ref: "MCP_TEST_TOKEN" } },
      };
      const desired = yield* reconciler.desired(props);

      // The resolved secret bytes never enter `desired` — only which keys
      // are declared, never a secret-sourced one's value.
      expect(JSON.stringify(desired)).not.toContain("sk-live-value");
      expect(desired.envKeys).toEqual(["API_KEY"]);
      expect(desired.envLiteral).toBeUndefined();

      yield* reconciler
        .apply({ props, observed: undefined, desired }, applyCtx)
        .pipe(Effect.provide(envConfig({ MCP_TEST_TOKEN: "sk-live-value" })));

      // The live file genuinely holds the resolved value — these tools store
      // credentials in plaintext regardless of machine-run, and a backend
      // that refused to write it would not register a working server.
      const written = JSON.parse(yield* fs.readFileString(path.join(home, ".claude.json")));
      expect(written.mcpServers["my-server"].env.API_KEY).toBe("sk-live-value");

      const observed = yield* reconciler.observe(props, observeCtx);
      expect(JSON.stringify(observed)).not.toContain("sk-live-value");
      expect(observed!.envKeys).toEqual(["API_KEY"]);
      expect(reconciler.matches(observed!, desired)).toBe(true);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "rotating a secret's value behind an unchanged ref is undetectable — the same documented limitation as Machine.SecretFile",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const reconciler = yield* makeMcpServerReconciler.pipe(Effect.provide(withHome(home)));

      const props: McpServerProps = {
        tool: "claude",
        name: "my-server",
        command: "npx",
        env: { API_KEY: { source: "env", ref: "MCP_TEST_TOKEN_ROTATE" } },
      };
      const desired = yield* reconciler.desired(props);
      yield* reconciler
        .apply({ props, observed: undefined, desired }, applyCtx)
        .pipe(Effect.provide(envConfig({ MCP_TEST_TOKEN_ROTATE: "sk-original" })));

      // The secret rotates in the store without machine-run's involvement —
      // `ref` is unchanged, only what it resolves to. Nothing here re-applies,
      // so this alone proves the store's new value is never even consulted by
      // `observe`/`matches`.
      const observed = yield* reconciler.observe(props, observeCtx);
      // Still reports satisfied: comparing the resolved value would mean
      // holding a secret in `matches`, which must never happen.
      expect(reconciler.matches(observed!, desired)).toBe(true);

      const written = JSON.parse(yield* fs.readFileString(path.join(home, ".claude.json")));
      expect(written.mcpServers["my-server"].env.API_KEY).toBe("sk-original");
    }).pipe(Effect.provide(layer)),
);

it.effect("adding a new env key, secret or literal, is drift even when every existing key still matches", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    const reconciler = yield* makeMcpServerReconciler.pipe(Effect.provide(withHome(home)));

    const props: McpServerProps = {
      tool: "claude",
      name: "my-server",
      command: "npx",
      env: { LOG_LEVEL: "debug" },
    };
    const desired = yield* reconciler.desired(props);
    yield* reconciler.apply({ props, observed: undefined, desired }, applyCtx);
    const observed = yield* reconciler.observe(props, observeCtx);

    const withExtra: McpServerProps = {
      ...props,
      env: { LOG_LEVEL: "debug", NODE_ENV: "production" },
    };
    const desiredWithExtra = yield* reconciler.desired(withExtra);
    expect(reconciler.matches(observed!, desiredWithExtra)).toBe(false);
  }).pipe(Effect.provide(layer)),
);

it.effect("observe reports absent for a server that was never registered", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    const reconciler = yield* makeMcpServerReconciler.pipe(Effect.provide(withHome(home)));

    const props: McpServerProps = { tool: "claude", name: "never-registered" };
    const observed = yield* reconciler.observe(props, observeCtx);
    expect(observed).toBeUndefined();
  }).pipe(Effect.provide(layer)),
);
