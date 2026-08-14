import { MachinePaths, MachinePathsLive } from "@machine-run/core";
import type { McpServerProps, McpServerState } from "@machine-run/ai";
import { makeMcpServerReconciler } from "@machine-run/ai";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { jsonRecordOr } from "../src/backends/jsonConfigFile.ts";

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

/**
 * Decodes a written config file's raw text as JSON — `Schema.Json` rather
 * than `JSON.parse`, so an actually malformed file fails the test with a
 * `SchemaError` instead of the ambient `JSON.parse` throw the plugin bans.
 */
const decodeWrittenDocument = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

/**
 * Reads one field out of a decoded document by successive keys, narrowing
 * one level at a time with `jsonRecordOr`. Every call site below only ever
 * hands the result to `expect(...).toEqual`/`toBe`, which accept any value,
 * so there is nothing further to narrow it to.
 */
const field = (doc: Schema.Json, ...path: readonly string[]): Schema.Json =>
  path.reduce((current, key) => jsonRecordOr(current, {})[key] ?? null, doc);

/** Serializes a value to compare against as a string — `Schema.Json` rather than `JSON.stringify`. */
const toJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

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

/** `stdioTransport` got a transport other than the `Stdio` variant it required. */
class UnexpectedTransport extends Data.TaggedError("UnexpectedTransport")<{
  readonly tag: string;
}> {
  override get message() {
    return `expected a Stdio transport, got ${this.tag}`;
  }
}

/**
 * `McpServerState.transport`'s `Stdio` half, narrowed from the union — every
 * test below builds a `Stdio` server, so this is the one place that repeats
 * the narrowing check rather than each assertion re-deriving it.
 */
const stdioTransport = (state: McpServerState) => {
  const transport = state.transport;
  return Result.getOrThrow(
    Result.liftPredicate(
      transport,
      (t): t is Extract<NonNullable<typeof t>, { _tag: "Stdio" }> =>
        t !== undefined && t._tag === "Stdio",
      (t) => new UnexpectedTransport({ tag: t === undefined ? "undefined" : t._tag }),
    ),
  );
};

// `McpServerProps.transport` models "stdio xor remote" as a tagged union —
// neither transport (`{}`) and both at once (`command` and `url` together)
// each used to type-check despite being documented as mutually exclusive.
// These are compile-time guards: removing the tagged union (reverting to
// independently `optionalKey` `command`/`args`/`env`/`url`/`headers`) makes
// both `@ts-expect-error`s below stop being errors, which is exactly the
// regression they exist to catch.
// @ts-expect-error -- neither `command` nor `url`: no such `McpServerProps` exists.
const _neitherTransport: McpServerProps = { tool: "claude", name: "x" };
// The literal is kept on one line deliberately: `@ts-expect-error` suppresses
// only the line that follows it, and a multi-line object literal reports the
// excess property against whichever inner line carries it.
// @ts-expect-error -- `command` and `url` together: no such `McpServerProps` exists.
const _bothTransport: McpServerProps = { tool: "claude", name: "x", command: "npx", url: "u" };

it.effect("apply registers a stdio server, and a later observe reports it as matching", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    const reconciler = yield* makeMcpServerReconciler.pipe(Effect.provide(withHome(home)));

    const props: McpServerProps = {
      tool: "claude",
      name: "my-server",
      transport: {
        _tag: "Stdio",
        command: "npx",
        args: ["-y", "my-mcp-server"],
        env: { LOG_LEVEL: "debug" },
      },
    };
    const desired = yield* reconciler.desired(props);
    yield* reconciler.apply({ props, observed: undefined, desired }, applyCtx);

    const observed = yield* reconciler.observe(props, observeCtx);
    expect(observed).toBeDefined();
    expect(reconciler.matches(observed!, desired)).toBe(true);

    const written = yield* decodeWrittenDocument(
      yield* fs.readFileString(path.join(home, ".claude.json")),
    );
    expect(field(written, "mcpServers", "my-server")).toEqual({
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
      transport: { _tag: "Stdio", command: "npx", env: { LOG_LEVEL: "debug" } },
    };
    const desired = yield* reconciler.desired(props);
    yield* reconciler.apply({ props, observed: undefined, desired }, applyCtx);

    const changedProps: McpServerProps = {
      ...props,
      transport: { _tag: "Stdio", command: "npx", env: { LOG_LEVEL: "trace" } },
    };
    const changedDesired = yield* reconciler.desired(changedProps);
    const observed = yield* reconciler.observe(props, observeCtx);
    expect(reconciler.matches(observed!, changedDesired)).toBe(false);

    yield* reconciler.apply({ props: changedProps, observed, desired: changedDesired }, applyCtx);
    const written = yield* decodeWrittenDocument(
      yield* fs.readFileString(path.join(home, ".claude.json")),
    );
    expect(field(written, "mcpServers", "my-server", "env")).toEqual({ LOG_LEVEL: "trace" });
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
        transport: {
          _tag: "Stdio",
          command: "npx",
          env: { API_KEY: { _tag: "Env", variable: "MCP_TEST_TOKEN" } },
        },
      };
      const desired = yield* reconciler.desired(props);

      // The resolved secret bytes never enter `desired` — only which keys
      // are declared, never a secret-sourced one's value.
      expect(toJsonString(desired)).not.toContain("sk-live-value");
      expect(stdioTransport(desired).envKeys).toEqual(["API_KEY"]);
      expect(stdioTransport(desired).envLiteral).toBeUndefined();

      yield* reconciler
        .apply({ props, observed: undefined, desired }, applyCtx)
        .pipe(Effect.provide(envConfig({ MCP_TEST_TOKEN: "sk-live-value" })));

      // The live file genuinely holds the resolved value — these tools store
      // credentials in plaintext regardless of machine-run, and a backend
      // that refused to write it would not register a working server.
      const written = yield* decodeWrittenDocument(
        yield* fs.readFileString(path.join(home, ".claude.json")),
      );
      expect(field(written, "mcpServers", "my-server", "env", "API_KEY")).toBe("sk-live-value");

      const observed = yield* reconciler.observe(props, observeCtx);
      expect(toJsonString(observed ?? null)).not.toContain("sk-live-value");
      expect(stdioTransport(observed!).envKeys).toEqual(["API_KEY"]);
      expect(reconciler.matches(observed!, desired)).toBe(true);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "rotating a secret's value behind an unchanged source is undetectable — the same documented limitation as Machine.SecretFile",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const reconciler = yield* makeMcpServerReconciler.pipe(Effect.provide(withHome(home)));

      const props: McpServerProps = {
        tool: "claude",
        name: "my-server",
        transport: {
          _tag: "Stdio",
          command: "npx",
          env: { API_KEY: { _tag: "Env", variable: "MCP_TEST_TOKEN_ROTATE" } },
        },
      };
      const desired = yield* reconciler.desired(props);
      yield* reconciler
        .apply({ props, observed: undefined, desired }, applyCtx)
        .pipe(Effect.provide(envConfig({ MCP_TEST_TOKEN_ROTATE: "sk-original" })));

      // The secret rotates in the store without machine-run's involvement —
      // the `Env` source's `variable` is unchanged, only what it resolves to.
      // Nothing here re-applies, so this alone proves the store's new value
      // is never even consulted by `observe`/`matches`.
      const observed = yield* reconciler.observe(props, observeCtx);
      // Still reports satisfied: comparing the resolved value would mean
      // holding a secret in `matches`, which must never happen.
      expect(reconciler.matches(observed!, desired)).toBe(true);

      const written = yield* decodeWrittenDocument(
        yield* fs.readFileString(path.join(home, ".claude.json")),
      );
      expect(field(written, "mcpServers", "my-server", "env", "API_KEY")).toBe("sk-original");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "adding a new env key, secret or literal, is drift even when every existing key still matches",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const reconciler = yield* makeMcpServerReconciler.pipe(Effect.provide(withHome(home)));

      const props: McpServerProps = {
        tool: "claude",
        name: "my-server",
        transport: { _tag: "Stdio", command: "npx", env: { LOG_LEVEL: "debug" } },
      };
      const desired = yield* reconciler.desired(props);
      yield* reconciler.apply({ props, observed: undefined, desired }, applyCtx);
      const observed = yield* reconciler.observe(props, observeCtx);

      const withExtra: McpServerProps = {
        ...props,
        transport: {
          _tag: "Stdio",
          command: "npx",
          env: { LOG_LEVEL: "debug", NODE_ENV: "production" },
        },
      };
      const desiredWithExtra = yield* reconciler.desired(withExtra);
      expect(reconciler.matches(observed!, desiredWithExtra)).toBe(false);
    }).pipe(Effect.provide(layer)),
);

it.effect("apply registers a remote server, and a later observe reports it as matching", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    const reconciler = yield* makeMcpServerReconciler.pipe(Effect.provide(withHome(home)));

    const props: McpServerProps = {
      tool: "claude",
      name: "my-remote-server",
      transport: {
        _tag: "Remote",
        url: "https://mcp.example.test",
        headers: { "X-Api-Key": "literal-header-value" },
      },
    };
    const desired = yield* reconciler.desired(props);
    yield* reconciler.apply({ props, observed: undefined, desired }, applyCtx);

    const observed = yield* reconciler.observe(props, observeCtx);
    expect(observed).toBeDefined();
    expect(reconciler.matches(observed!, desired)).toBe(true);

    const written = yield* decodeWrittenDocument(
      yield* fs.readFileString(path.join(home, ".claude.json")),
    );
    // Claude's own config marks a remote server with `type: "http"` — see
    // `backends/Claude.ts`'s `apply`.
    expect(field(written, "mcpServers", "my-remote-server")).toEqual({
      type: "http",
      url: "https://mcp.example.test",
      headers: { "X-Api-Key": "literal-header-value" },
    });
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a stdio server never matches a remote-shaped desired state — the transport tag is real drift too",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const reconciler = yield* makeMcpServerReconciler.pipe(Effect.provide(withHome(home)));

      const stdioProps: McpServerProps = {
        tool: "claude",
        name: "my-server",
        transport: { _tag: "Stdio", command: "npx" },
      };
      const stdioDesired = yield* reconciler.desired(stdioProps);
      yield* reconciler.apply(
        { props: stdioProps, observed: undefined, desired: stdioDesired },
        applyCtx,
      );
      const observed = yield* reconciler.observe(stdioProps, observeCtx);

      const remoteProps: McpServerProps = {
        tool: "claude",
        name: "my-server",
        transport: { _tag: "Remote", url: "https://mcp.example.test" },
      };
      const remoteDesired = yield* reconciler.desired(remoteProps);
      expect(reconciler.matches(observed!, remoteDesired)).toBe(false);
    }).pipe(Effect.provide(layer)),
);

it.effect("observe reports absent for a server that was never registered", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    const reconciler = yield* makeMcpServerReconciler.pipe(Effect.provide(withHome(home)));

    const props: McpServerProps = {
      tool: "claude",
      name: "never-registered",
      transport: { _tag: "Stdio", command: "npx" },
    };
    const observed = yield* reconciler.observe(props, observeCtx);
    expect(observed).toBeUndefined();
  }).pipe(Effect.provide(layer)),
);

/**
 * `address` is what the engine derives mutual exclusion and pre-overwrite
 * snapshotting from, so two resources that write one file must produce the same
 * address string. This one used to be a synthetic `ai-mcp-config:<tool>` key,
 * which serialised `Ai.McpServer` resources against each other and against
 * nothing else — a `Machine.File` or `Machine.ManagedBlock` on the same
 * `~/.claude.json` computes a path, so the two shared no lock and could
 * interleave read-modify-write cycles over one document.
 *
 * The assertion is deliberately against `paths.expand("~/.claude.json")` rather
 * than against a hand-written string: that is exactly the expression every
 * path-addressed reconciler in the repo uses, so this compares the two things
 * that actually have to agree.
 */
it.effect("addresses the real config file, identically to a path-addressed resource", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    const reconciler = yield* makeMcpServerReconciler.pipe(Effect.provide(withHome(home)));
    const paths = yield* MachinePaths.pipe(Effect.provide(withHome(home)));

    const props: McpServerProps = {
      tool: "claude",
      name: "srv",
      transport: { _tag: "Stdio", command: "npx" },
    };
    const address = reconciler.address(props);

    expect(address).toBe(paths.expand("~/.claude.json"));
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

/** Two tools write two different files, so they must not serialise against
 * each other — the same property in the other direction. */
it.effect("two tools do not share an address", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    const reconciler = yield* makeMcpServerReconciler.pipe(Effect.provide(withHome(home)));

    const claude: McpServerProps = {
      tool: "claude",
      name: "srv",
      transport: { _tag: "Stdio", command: "npx" },
    };
    const opencode: McpServerProps = {
      tool: "config-opencode",
      name: "srv",
      transport: { _tag: "Stdio", command: "npx" },
    };

    expect(reconciler.address(claude)).not.toBe(reconciler.address(opencode));

  }).pipe(Effect.scoped, Effect.provide(layer)),
);
