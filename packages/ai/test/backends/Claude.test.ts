import type { AiToolContext } from "@machine-run/ai";
import { ClaudeBackend } from "@machine-run/ai";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { platform as nodePlatform } from "node:os";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { jsonRecordOr } from "../../src/backends/jsonConfigFile.ts";

/** Decodes a written config file's raw text as JSON — `Schema.Json` rather than `JSON.parse`. */
const decodeWrittenDocument = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

/**
 * Reads one field out of a decoded document by successive keys, narrowing
 * one level at a time. Every call site below only hands the result to
 * `expect(...).toEqual`/`toBe`, which accept any value.
 */
const field = (doc: Schema.Json, ...path: readonly string[]): Schema.Json =>
  path.reduce((current, key) => jsonRecordOr(current, {})[key] ?? null, doc);

/**
 * A real `~/.claude.json`, trimmed but otherwise byte-for-byte what running
 * the actual, installed `claude` CLI (`claude mcp add-json testserver ...
 * -s user`) wrote against an isolated `$HOME` — see docs/ai-notes.md. This is
 * the fixture the "preserve everything else" guarantee has to hold against:
 * a real client state file with dozens of unrelated keys and one
 * already-registered server.
 */
const REAL_CLAUDE_JSON = Schema.encodeSync(Schema.fromJsonString(Schema.Json, { space: 2 }))({
  firstStartTime: "2026-08-13T04:29:50.485Z",
  machineID: "39c6d1f88e9ff5de5fb5dc8888812647353dddc00943e6fc88bb1e5696f617a4",
  opusProMigrationComplete: true,
  sonnet1m45MigrationComplete: true,
  seenNotifications: {},
  hasResetAutoModeOptInForDefaultOffer: true,
  migrationVersion: 13,
  userID: "e430027d06a554482ab379645ff49a5878c4e162f26234e306ff38f68ed56eb9",
  mcpServers: {
    testserver: {
      command: "npx",
      args: ["-y", "my-mcp-server"],
      env: { API_KEY: "xxx" },
    },
  },
});

const layer = NodeServices.layer;

const POSIX_PERMISSIONS_AVAILABLE = nodePlatform() !== "win32";

const dieExec: AiToolContext["exec"] = () => Effect.die("claude backend never calls exec");

it.effect(
  "apply merges a new server in without disturbing any other top-level key or any other server",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(path.join(home, ".claude.json"), REAL_CLAUDE_JSON);

      const ctx: AiToolContext = { exec: dieExec, fs, path, home };
      yield* ClaudeBackend.mcp!.apply(
        "newserver",
        { url: "https://example.com/mcp", headers: { Authorization: "Bearer secret-token" } },
        ctx,
      );

      const written = yield* decodeWrittenDocument(
        yield* fs.readFileString(path.join(home, ".claude.json")),
      );

      // Every unrelated top-level key survives untouched.
      expect(field(written, "machineID")).toBe(
        "39c6d1f88e9ff5de5fb5dc8888812647353dddc00943e6fc88bb1e5696f617a4",
      );
      expect(field(written, "migrationVersion")).toBe(13);
      expect(field(written, "seenNotifications")).toEqual({});
      expect(field(written, "opusProMigrationComplete")).toBe(true);

      // The pre-existing server is untouched.
      expect(field(written, "mcpServers", "testserver")).toEqual({
        command: "npx",
        args: ["-y", "my-mcp-server"],
        env: { API_KEY: "xxx" },
      });

      // The new one was added, in Claude Code's own remote-server shape.
      expect(field(written, "mcpServers", "newserver")).toEqual({
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer secret-token" },
      });
    }).pipe(Effect.provide(layer)),
);

it.effect("apply updates an existing server in place rather than duplicating it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(path.join(home, ".claude.json"), REAL_CLAUDE_JSON);

    const ctx: AiToolContext = { exec: dieExec, fs, path, home };
    yield* ClaudeBackend.mcp!.apply(
      "testserver",
      { command: "npx", args: ["-y", "my-mcp-server-v2"], env: { API_KEY: "yyy" } },
      ctx,
    );

    const written = yield* decodeWrittenDocument(
      yield* fs.readFileString(path.join(home, ".claude.json")),
    );
    expect(Object.keys(jsonRecordOr(field(written, "mcpServers"), {}))).toEqual(["testserver"]);
    expect(field(written, "mcpServers", "testserver")).toEqual({
      command: "npx",
      args: ["-y", "my-mcp-server-v2"],
      env: { API_KEY: "yyy" },
    });
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "remove deletes only the named server, leaving every other server and top-level key untouched",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(path.join(home, ".claude.json"), REAL_CLAUDE_JSON);

      const ctx: AiToolContext = { exec: dieExec, fs, path, home };
      yield* ClaudeBackend.mcp!.apply("second", { command: "npx", args: ["other"] }, ctx);
      yield* ClaudeBackend.mcp!.remove("second", ctx);

      const written = yield* decodeWrittenDocument(
        yield* fs.readFileString(path.join(home, ".claude.json")),
      );
      expect(field(written, "mcpServers", "second")).toBeNull();
      expect(field(written, "mcpServers", "testserver")).toEqual({
        command: "npx",
        args: ["-y", "my-mcp-server"],
        env: { API_KEY: "xxx" },
      });
      expect(field(written, "machineID")).toBe(
        "39c6d1f88e9ff5de5fb5dc8888812647353dddc00943e6fc88bb1e5696f617a4",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("remove is a no-op when the named server was never registered", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(path.join(home, ".claude.json"), REAL_CLAUDE_JSON);

    const ctx: AiToolContext = { exec: dieExec, fs, path, home };
    yield* ClaudeBackend.mcp!.remove("does-not-exist", ctx);

    expect(yield* fs.readFileString(path.join(home, ".claude.json"))).toBe(REAL_CLAUDE_JSON);
  }).pipe(Effect.provide(layer)),
);

it.effect("observe reports undefined for a server that was never registered", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(path.join(home, ".claude.json"), REAL_CLAUDE_JSON);

    const ctx: AiToolContext = { exec: dieExec, fs, path, home };
    const observed = yield* ClaudeBackend.mcp!.observe("does-not-exist", ctx);
    expect(observed).toBeUndefined();
  }).pipe(Effect.provide(layer)),
);

it.effect("observe round-trips a stdio server exactly as apply wrote it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(path.join(home, ".claude.json"), REAL_CLAUDE_JSON);

    const ctx: AiToolContext = { exec: dieExec, fs, path, home };
    const observed = yield* ClaudeBackend.mcp!.observe("testserver", ctx);
    expect(observed).toEqual({
      command: "npx",
      args: ["-y", "my-mcp-server"],
      env: { API_KEY: "xxx" },
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("apply creates ~/.claude.json from scratch when it does not exist yet", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();

    const ctx: AiToolContext = { exec: dieExec, fs, path, home };
    yield* ClaudeBackend.mcp!.apply("first", { command: "npx", args: ["thing"] }, ctx);

    const written = yield* decodeWrittenDocument(
      yield* fs.readFileString(path.join(home, ".claude.json")),
    );
    expect(field(written, "mcpServers", "first")).toEqual({ command: "npx", args: ["thing"] });
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a config file that isn't valid JSON fails with a typed AiToolConfigMalformed rather than being silently replaced",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(path.join(home, ".claude.json"), "not json at all {{{");

      const ctx: AiToolContext = { exec: dieExec, fs, path, home };
      const error = yield* ClaudeBackend.mcp!.apply("first", { command: "npx" }, ctx).pipe(
        Effect.flip,
      );

      expect(error).toMatchObject({ _tag: "AiToolConfigMalformed" });
      // Untouched — a malformed file is never overwritten to "fix" it.
      expect(yield* fs.readFileString(path.join(home, ".claude.json"))).toBe("not json at all {{{");
    }).pipe(Effect.provide(layer)),
);

/**
 * `mcpServers[].env` and `headers` are typed to accept `Redacted<string>`, so
 * this file is a credential store by design. It was previously written with
 * no mode at all, which on a default umask means 0644 — the API key of every
 * registered MCP server, world-readable.
 *
 * Both directions are asserted because they fail for different reasons: the
 * OS applies a write's `mode` only when the file is created, so a fresh file
 * needs the mode passed on the write, and a file some other tool already
 * created at 0644 needs the explicit chmod or it keeps those bits forever.
 */
it.effect.skipIf(!POSIX_PERMISSIONS_AVAILABLE)(
  "writes a fresh config at 0600, in a 0700 directory",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const configDir = path.join(home, "nested");

      const ctx: AiToolContext = { exec: dieExec, fs, path, home: configDir };
      yield* ClaudeBackend.mcp!.apply(
        "newserver",
        { command: "npx", args: ["-y", "srv"], env: { API_KEY: "super-secret" } },
        ctx,
      );

      const fileInfo = yield* fs.stat(path.join(configDir, ".claude.json"));
      const dirInfo = yield* fs.stat(configDir);
      expect(Number(fileInfo.mode) & 0o777).toBe(0o600);
      expect(Number(dirInfo.mode) & 0o777).toBe(0o700);
    }).pipe(Effect.provide(layer)),
);

it.effect.skipIf(!POSIX_PERMISSIONS_AVAILABLE)(
  "tightens a config another tool already created world-readable",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const configPath = path.join(home, ".claude.json");
      yield* fs.writeFileString(configPath, REAL_CLAUDE_JSON);
      yield* fs.chmod(configPath, 0o644);

      const ctx: AiToolContext = { exec: dieExec, fs, path, home };
      yield* ClaudeBackend.mcp!.apply(
        "newserver",
        { command: "npx", args: ["-y", "srv"], env: { API_KEY: "super-secret" } },
        ctx,
      );

      const info = yield* fs.stat(configPath);
      expect(Number(info.mode) & 0o777).toBe(0o600);
    }).pipe(Effect.provide(layer)),
);
