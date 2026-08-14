import type { AiToolContext } from "@machine-run/ai";
import { OpenCodeBackend } from "@machine-run/ai";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
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
 * A real `opencode.jsonc`, verified by running the actual, installed
 * `opencode` CLI (`opencode mcp add ... --url ...` and `... --env K=V --
 * cmd args...`) against an isolated `$HOME` and reading back what it wrote —
 * see docs/ai-notes.md. `plugins`/`providers` are the same shape this
 * machine's real `~/.config/opencode/opencode.jsonc` carries.
 */
const REAL_OPENCODE_JSONC = Schema.encodeSync(Schema.fromJsonString(Schema.Json, { space: 2 }))({
  $schema: "https://opencode.ai/config.json",
  plugins: ["./plugin/lmstudio-v2.ts", "./plugin/restart-command.ts"],
  providers: {
    lmstudio: {
      name: "LM Studio",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://127.0.0.1:1234/v1" },
    },
  },
  mcp: {
    existing: {
      type: "remote",
      url: "https://example.com/mcp",
    },
  },
});

const layer = NodeServices.layer;

const dieExec: AiToolContext["exec"] = () => Effect.die("opencode backend never calls exec");

const configPathOf = (path: Path.Path, home: string) =>
  path.join(home, ".config/opencode/opencode.jsonc");

it.effect(
  "apply merges a new local server in without disturbing plugins, providers, or the existing server",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(home, ".config/opencode"), { recursive: true });
      yield* fs.writeFileString(configPathOf(path, home), REAL_OPENCODE_JSONC);

      const ctx: AiToolContext = { exec: dieExec, fs, path, home };
      yield* OpenCodeBackend.mcp!.apply(
        "localtest",
        { command: "npx", args: ["-y", "my-mcp-server"], env: { API_KEY: "xxx" } },
        ctx,
      );

      const written = yield* decodeWrittenDocument(
        yield* fs.readFileString(configPathOf(path, home)),
      );

      expect(field(written, "plugins")).toEqual([
        "./plugin/lmstudio-v2.ts",
        "./plugin/restart-command.ts",
      ]);
      expect(field(written, "providers", "lmstudio", "options", "baseURL")).toBe(
        "http://127.0.0.1:1234/v1",
      );
      expect(field(written, "mcp", "existing")).toEqual({
        type: "remote",
        url: "https://example.com/mcp",
      });

      // opencode's own real shape: the whole argv as one `command` array,
      // and `environment`, not `env`.
      expect(field(written, "mcp", "localtest")).toEqual({
        type: "local",
        command: ["npx", "-y", "my-mcp-server"],
        environment: { API_KEY: "xxx" },
      });
    }).pipe(Effect.provide(layer)),
);

it.effect("observe round-trips the pre-existing remote server", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(path.join(home, ".config/opencode"), { recursive: true });
    yield* fs.writeFileString(configPathOf(path, home), REAL_OPENCODE_JSONC);

    const ctx: AiToolContext = { exec: dieExec, fs, path, home };
    const observed = yield* OpenCodeBackend.mcp!.observe("existing", ctx);
    expect(observed).toEqual({ url: "https://example.com/mcp" });
  }).pipe(Effect.provide(layer)),
);

it.effect("apply creates the config file and its parent directory when neither exists yet", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();

    const ctx: AiToolContext = { exec: dieExec, fs, path, home };
    yield* OpenCodeBackend.mcp!.apply("first", { command: "npx" }, ctx);

    const written = yield* decodeWrittenDocument(yield* fs.readFileString(configPathOf(path, home)));
    expect(field(written, "mcp", "first")).toEqual({ type: "local", command: ["npx"] });
  }).pipe(Effect.provide(layer)),
);

/**
 * The same credential discipline `Claude.test.ts` asserts, for the same
 * reason: `mcp[].environment` accepts `Redacted<string>`, so this file holds
 * API keys and must not be written at the process umask. Note the directory
 * here is `~/.config/opencode`, created by this backend rather than the
 * user, which makes the 0700 assertion meaningful rather than incidental.
 */
it.effect("writes a fresh config at 0600, in a 0700 directory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();

    const ctx: AiToolContext = { exec: dieExec, fs, path, home };
    yield* OpenCodeBackend.mcp!.apply(
      "localtest",
      { command: "npx", args: ["-y", "srv"], env: { API_KEY: "super-secret" } },
      ctx,
    );

    const fileInfo = yield* fs.stat(configPathOf(path, home));
    const dirInfo = yield* fs.stat(path.join(home, ".config/opencode"));
    expect(Number(fileInfo.mode) & 0o777).toBe(0o600);
    expect(Number(dirInfo.mode) & 0o777).toBe(0o700);
  }).pipe(Effect.provide(layer)),
);

it.effect("tightens a config another tool already created world-readable", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(path.join(home, ".config/opencode"), { recursive: true });
    yield* fs.writeFileString(configPathOf(path, home), REAL_OPENCODE_JSONC);
    yield* fs.chmod(configPathOf(path, home), 0o644);

    const ctx: AiToolContext = { exec: dieExec, fs, path, home };
    yield* OpenCodeBackend.mcp!.apply(
      "localtest",
      { command: "npx", args: ["-y", "srv"], env: { API_KEY: "super-secret" } },
      ctx,
    );

    const info = yield* fs.stat(configPathOf(path, home));
    expect(Number(info.mode) & 0o777).toBe(0o600);
  }).pipe(Effect.provide(layer)),
);
