import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { AiToolConfigMalformed, type AiMcpServerSpec, type AiToolBackend } from "../Backend.ts";
import { classifyCliError, metaToken } from "./cliMcp.ts";

/**
 * `grok mcp list --json`'s own shape, verified by running the real,
 * installed `grok` CLI (`1.0.3`) against an isolated `$HOME` inside a Docker
 * container and reading its output. Unlike Codex, Grok has no `mcp get
 * <name>`, only `list` — the whole registry, filtered here by `name`.
 *
 * `headers` is real: a remote server added via `grok mcp add --transport http
 * <name> <url> -H "K: V"` shows up in `grok mcp list --json` as
 * `{ url, headers, enabled, name, scope }`, not merely `{ url, ... }` — an
 * earlier version of this schema omitted the field entirely, which silently
 * decoded (Effect's `Schema.Struct` ignores excess input keys rather than
 * rejecting them) but then had nothing to hand to `entryToSpec` below,
 * meaning `observe` could never report a remote server's headers back to
 * `Ai.McpServer`'s reconciliation even though `apply` can set them. Fixed in
 * this session after the container run above showed the real field.
 */
const GrokServer = Schema.Struct({
  name: Schema.String,
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  url: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const GrokList = Schema.fromJsonString(Schema.Array(GrokServer));
const decodeGrokList = Schema.decodeUnknownEffect(GrokList);

const CONFIG_PATH = "~/.grok/config.toml";

/**
 * Grok Build, re-verified this session directly against the real, installed
 * `grok` CLI (`@xai-official/grok@1.0.3`, xAI's own package — installed with
 * `npm install -g @xai-official/grok` in a `node:22-slim` container, `HOME`
 * pointed at the container's own isolated `/root`, never this Mac's real
 * `~/.grok`):
 *
 * - `grok mcp add -e LOG_LEVEL=debug postgres -- npx -y
 *   @modelcontextprotocol/server-postgres` wrote
 *   `[mcp_servers.postgres]`/`[mcp_servers.postgres.env]` to
 *   `~/.grok/config.toml`, exactly the table shape below expects.
 * - `grok mcp add --transport http sentry https://mcp.sentry.dev/mcp -H
 *   "Authorization: Bearer secrettoken"` wrote
 *   `[mcp_servers.sentry]`/`[mcp_servers.sentry.headers]` — Grok really does
 *   take `-H "K: V"` for remote servers, unlike Codex.
 * - `grok mcp list --json` afterward returned both servers as one array;
 *   the postgres entry decoded exactly as `GrokServer` expects, but the
 *   sentry entry's real shape was `{ url, headers, enabled, name, scope }` —
 *   **`headers` was missing from `GrokServer` before this session**, so
 *   `observe` silently dropped a remote server's headers on every read even
 *   though `apply` could set them. Fixed above; `entryToSpec` now forwards
 *   `headers` alongside `url`.
 * - Running `grok mcp add` a second time against an already-registered name
 *   (`postgres`, with a changed arg and env value) updated the same
 *   `[mcp_servers.postgres]` table in place rather than duplicating it —
 *   genuinely add-or-update, the same as Codex's.
 * - `grok mcp get x --json` isn't a real subcommand (`grok mcp --help` lists
 *   only `list`/`add`/`remove`/`enable`/`disable`/`doctor`, matching this
 *   file's comment above that Grok has no `mcp get <name>`); running an
 *   unknown binary in the same container produced `bash: line 1:
 *   nonexistent-grok-binary: command not found`, confirming `isCommandNotFound`
 *   in `cliMcp.ts` matches this shell's real wording (exit 127).
 * - `grok --help` and a `grok mcp --help`/`add --help`/`list --help` walk
 *   confirmed every flag this backend emits (`-e`, `-H`, `--transport http`,
 *   `--json`) is real, and that env values are `-e KEY=value` while headers
 *   are `-H "KEY: VALUE"` — asymmetric separators, matching `metaToken`'s
 *   two call sites in `apply` below.
 * - `~/.grok/skills/<name>/SKILL.md` is a real path: the installed CLI's own
 *   compiled binary (Brotli-decompressed and grepped for literal strings)
 *   contains `.grok/skills`, `skills/commit/SKILL.md`, and toggles like
 *   `claude_skills_enabled`/`cursor_skills_enabled` alongside it, confirming
 *   Grok Build does read a `skills/` directory the same way Claude Code does.
 *
 * Its TOML shape (`[mcp_servers.<name>]` with a nested `.env`/`.headers`
 * table) is structurally the same table Codex writes, but Grok's `list
 * --json` is the more useful observation surface — a single call returns
 * every server, rather than one `get` per name.
 *
 * No TOML library is installed in this workspace (see `Codex.ts`'s doc
 * comment and docs/ai-notes.md), so this backend shells out to `grok`'s own
 * add/list lifecycle rather than parsing `config.toml` directly.
 */
export const GrokBackend: AiToolBackend = {
  id: "grok",
  skillsDir: ".grok/skills",
  reviewedConfigFiles: [".grok/config.toml"],
  mcp: {
    // Mutated through `grok mcp add/list`, never written directly, but this is
    // still the file those subcommands contend for.
    configFile: (home, path) => path.join(home, ".grok/config.toml"),

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
            ? {
                url: found.url,
                ...(found.headers !== undefined ? { headers: found.headers } : {}),
              }
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
          .exec({
            // Same escape hatch as `Codex.ts`: a user-named binary with
            // user-supplied args (the config being installed), each already
            // quoted individually above via `Sh.quote`/`metaToken`.
            command: Sh.unsafeRaw(
              parts.join(" "),
              "Ai.McpServer launches a user-named binary with user-supplied args, individually quoted above",
            ),
            shell: true,
            env,
          })
          .pipe(
            Effect.catchTag("CommandError", (error) => classifyCliError("grok", "grok", error)),
          );
      }),
  },
};
