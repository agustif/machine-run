import type { AiToolContext } from "@machine-run/ai";
import { ClaudeBackend } from "@machine-run/ai";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * A real `~/.claude.json`, trimmed but otherwise byte-for-byte what running
 * the actual, installed `claude` CLI (`claude mcp add-json testserver ...
 * -s user`) wrote against an isolated `$HOME` — see docs/ai-notes.md. This is
 * the fixture the "preserve everything else" guarantee has to hold against:
 * a real client state file with dozens of unrelated keys and one
 * already-registered server.
 */
const REAL_CLAUDE_JSON = JSON.stringify(
  {
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
  },
  null,
  2,
);

const layer = NodeServices.layer;

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

      const written = JSON.parse(yield* fs.readFileString(path.join(home, ".claude.json")));

      // Every unrelated top-level key survives untouched.
      expect(written.machineID).toBe(
        "39c6d1f88e9ff5de5fb5dc8888812647353dddc00943e6fc88bb1e5696f617a4",
      );
      expect(written.migrationVersion).toBe(13);
      expect(written.seenNotifications).toEqual({});
      expect(written.opusProMigrationComplete).toBe(true);

      // The pre-existing server is untouched.
      expect(written.mcpServers.testserver).toEqual({
        command: "npx",
        args: ["-y", "my-mcp-server"],
        env: { API_KEY: "xxx" },
      });

      // The new one was added, in Claude Code's own remote-server shape.
      expect(written.mcpServers.newserver).toEqual({
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

    const written = JSON.parse(yield* fs.readFileString(path.join(home, ".claude.json")));
    expect(Object.keys(written.mcpServers)).toEqual(["testserver"]);
    expect(written.mcpServers.testserver).toEqual({
      command: "npx",
      args: ["-y", "my-mcp-server-v2"],
      env: { API_KEY: "yyy" },
    });
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

    const written = JSON.parse(yield* fs.readFileString(path.join(home, ".claude.json")));
    expect(written.mcpServers.first).toEqual({ command: "npx", args: ["thing"] });
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
