import type { AiToolContext } from "@machine-run/ai";
import { OpenCodeBackend } from "@machine-run/ai";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * A real `opencode.jsonc`, verified by running the actual, installed
 * `opencode` CLI (`opencode mcp add ... --url ...` and `... --env K=V --
 * cmd args...`) against an isolated `$HOME` and reading back what it wrote —
 * see docs/ai-notes.md. `plugins`/`providers` are the same shape this
 * machine's real `~/.config/opencode/opencode.jsonc` carries.
 */
const REAL_OPENCODE_JSONC = JSON.stringify(
  {
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
  },
  null,
  2,
);

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

      const written = JSON.parse(yield* fs.readFileString(configPathOf(path, home)));

      expect(written.plugins).toEqual([
        "./plugin/lmstudio-v2.ts",
        "./plugin/restart-command.ts",
      ]);
      expect(written.providers.lmstudio.options.baseURL).toBe("http://127.0.0.1:1234/v1");
      expect(written.mcp.existing).toEqual({ type: "remote", url: "https://example.com/mcp" });

      // opencode's own real shape: the whole argv as one `command` array,
      // and `environment`, not `env`.
      expect(written.mcp.localtest).toEqual({
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

    const written = JSON.parse(yield* fs.readFileString(configPathOf(path, home)));
    expect(written.mcp.first).toEqual({ type: "local", command: ["npx"] });
  }).pipe(Effect.provide(layer)),
);
