import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { AiToolConfigMalformed, type AiMcpServerSpec, type AiToolBackend } from "../Backend.ts";
import { classifyCliError, metaToken } from "./cliMcp.ts";

/**
 * `grok mcp list --json`'s own shape, verified by running the real,
 * installed `grok` CLI against an isolated `$HOME` and reading its output.
 * Unlike Codex, Grok has no `mcp get <name>`, only `list` — the whole
 * registry, filtered here by `name`.
 */
const GrokServer = Schema.Struct({
  name: Schema.String,
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  url: Schema.optionalKey(Schema.String),
});

const GrokList = Schema.fromJsonString(Schema.Array(GrokServer));
const decodeGrokList = Schema.decodeUnknownEffect(GrokList);

const CONFIG_PATH = "~/.grok/config.toml";

/**
 * Grok Build, verified directly: `grok mcp add <name> -e K=V -- cmd
 * args...`, `grok mcp add --transport http <name> <url> -H "K: V"`, and
 * `grok mcp list --json`, all against an isolated `$HOME`, then reading back
 * the resulting `~/.grok/config.toml`. Its TOML shape (`[mcp_servers.<name>]`
 * with a nested `.env` table) is structurally the same table Codex writes,
 * but Grok's `list --json` is the more useful observation surface — a single
 * call returns every server, rather than one `get` per name.
 *
 * No TOML library is installed in this workspace (see `Codex.ts`'s doc
 * comment and docs/ai-notes.md), so this backend shells out to `grok`'s own
 * add/list lifecycle rather than parsing `config.toml` directly. `grok mcp
 * add` on an existing name updates it in place, verified the same way as
 * Codex's.
 */
export const GrokBackend: AiToolBackend = {
  id: "grok",
  skillsDir: ".grok/skills",
  reviewedConfigFiles: [".grok/config.toml"],
  mcp: {
    observe: (name, ctx) =>
      ctx.exec({ command: Sh.sh("grok", "mcp", "list", "--json"), shell: true }).pipe(
        Effect.flatMap((result) =>
          decodeGrokList(result.stdout).pipe(
            Effect.catchTag(
              "SchemaError",
              (cause) => new AiToolConfigMalformed({ tool: "grok", path: CONFIG_PATH, cause }),
            ),
          ),
        ),
        Effect.map((servers): AiMcpServerSpec | undefined => {
          const found = servers.find((server) => server.name === name);
          if (found === undefined) return undefined;
          return found.url !== undefined
            ? { url: found.url }
            : {
                ...(found.command !== undefined ? { command: found.command } : {}),
                ...(found.args !== undefined ? { args: found.args } : {}),
                ...(found.env !== undefined ? { env: found.env } : {}),
              };
        }),
        Effect.catchTag("CommandError", (error) => classifyCliError("grok", "grok", error)),
      ),

    apply: (name, desired, ctx) =>
      Effect.gen(function* () {
        const env: Record<string, string | Redacted.Redacted<string>> = {};
        const parts = ["grok", "mcp", "add"];

        if (desired.url !== undefined) {
          parts.push("--transport", "http", Sh.quote(name), Sh.quote(desired.url));
          Object.entries(desired.headers ?? {}).forEach(([key, value], index) => {
            parts.push("-H", metaToken(key, value, ": ", `MCP_SECRET_H${index}`, env));
          });
        } else {
          Object.entries(desired.env ?? {}).forEach(([key, value], index) => {
            parts.push("-e", metaToken(key, value, "=", `MCP_SECRET_${index}`, env));
          });
          parts.push(
            Sh.quote(name),
            "--",
            Sh.quote(desired.command ?? ""),
            ...(desired.args ?? []).map((arg) => Sh.quote(arg)),
          );
        }

        yield* ctx
          .exec({ command: parts.join(" "), shell: true, env })
          .pipe(
            Effect.catchTag("CommandError", (error) => classifyCliError("grok", "grok", error)),
          );
      }),
  },
};
