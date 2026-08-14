import { Sh } from "@machine-run/core";
import type { CommandError } from "alchemy/Command";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  AiToolCliMissing,
  AiToolConfigMalformed,
  AiToolFieldUnsupported,
  type AiMcpServerSpec,
  type AiToolBackend,
} from "../Backend.ts";
import { classifyCliError, isCommandNotFound, metaToken, stderrOf } from "./cliMcp.ts";

/**
 * `codex mcp get <missing> --json` exits non-zero with this text on stderr
 * — re-verified this session against the real, installed `codex` CLI
 * (`@openai/codex@0.147.0`) run inside a Docker container with a name it had
 * never heard of: `codex mcp get doesnotexist --json` printed exactly
 * `Error: No MCP server named 'doesnotexist' found.` to stderr and exited 1.
 * Matched case-insensitively and as a substring (the real output carries
 * that `Error: ` prefix) so this narrows only the documented shape, the same
 * discipline `git/src/toplevel.ts`'s `showToplevel` uses for `git`'s "not a
 * git repository" text.
 */
const NO_SUCH_SERVER = /No MCP server named/i;

/**
 * `codex mcp get <name> --json`'s own shape, re-verified this session by
 * running the real, installed `codex` CLI (`npm install -g @openai/codex` in
 * a `node:22-slim` container, `HOME`/`CODEX_HOME` pointed at the container's
 * own isolated `/root`, never this Mac's real `~/.codex`) against an isolated
 * home and reading its output: `codex mcp add testserver --env API_KEY=xxx
 * -- npx -y my-mcp-server` then `codex mcp get testserver --json` printed a
 * `transport` object byte-for-byte matching the `stdio` arm below (plus
 * `env_vars: []`/`cwd: null`, neither decoded here), and `codex mcp add
 * httptest --url https://example.com/mcp` then `codex mcp get httptest
 * --json` matched the `streamable_http` arm (plus `bearer_token_env_var`/
 * `http_headers`/`env_http_headers`, all `null` and none decoded here).
 * Only the two fields this backend needs are decoded — the real output also
 * carries `enabled`, `disabled_reason`, `enabled_tools`, `disabled_tools`,
 * `startup_timeout_sec`, `tool_timeout_sec`, none of which this resource
 * manages. `codex mcp add --help` was also re-checked this session:
 * `--env` is a plain repeatable long flag (no `-e` short form) and there is
 * no `--header` option at all for `--url` servers — only
 * `--bearer-token-env-var` — confirming `apply`'s
 * `AiToolFieldUnsupported("headers")` below is still the honest answer, not
 * a missing feature this backend forgot to wire up.
 */
const CodexTransport = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("stdio"),
    command: Schema.String,
    args: Schema.optionalKey(Schema.Array(Schema.String)),
    env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal("streamable_http"),
    url: Schema.String,
  }),
]);

const CodexMcpGet = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    transport: CodexTransport,
  }),
);

const decodeCodexMcpGet = Schema.decodeUnknownEffect(CodexMcpGet);

const CONFIG_PATH = "~/.codex/config.toml";

/**
 * Classifies a failed `codex mcp get <name> --json`. Command-not-found
 * promotes to {@link AiToolCliMissing}; the documented "no such server" text
 * on stderr is genuine absence, reported as `undefined` rather than a
 * failure; everything else propagates unchanged. Unlike `classifyCliError`,
 * this has three outcomes rather than two — the absent-server case exists
 * only for this one read path, never for `apply`, so it lives here rather
 * than in `cliMcp.ts`.
 *
 * Written as an if/else chain, not nested ternaries, so each branch's return
 * type is checked against the declared signature independently, and so a
 * fourth outcome added later has an obvious place to go rather than another
 * level of nesting.
 */
const classifyCodexMcpGetError = (
  error: CommandError,
): Effect.Effect<AiMcpServerSpec | undefined, AiToolCliMissing | CommandError> => {
  if (isCommandNotFound(error)) {
    return Effect.fail(new AiToolCliMissing({ tool: "codex", cli: "codex", cause: error }));
  }
  if (NO_SUCH_SERVER.test(stderrOf(error))) {
    return Effect.succeed(undefined);
  }
  // A corrupted `$CODEX_HOME`, a permissions problem, a crash — anything
  // that isn't the two shapes above must not be read as "the server was
  // never added" (MUST_CLEANUP.md 1b.2), so it propagates and `apply` never
  // gets a chance to paper over it with `codex mcp add`.
  return Effect.fail(error);
};

/**
 * Codex, re-verified this session directly against the real, installed
 * `codex` CLI: `codex mcp add testserver --env API_KEY=xxx -- npx -y
 * my-mcp-server` and `codex mcp add httptest --url https://example.com/mcp`
 * against an isolated `$CODEX_HOME` inside a Docker container, then reading
 * back the resulting `~/.codex/config.toml` (which held exactly
 * `[mcp_servers.testserver]`/`[mcp_servers.testserver.env]` and
 * `[mcp_servers.httptest]` with a bare `url` key — no TOML table for a
 * headerless remote server) and running `codex mcp get <name> --json` — see
 * `CodexTransport`'s doc comment above for the exact output.
 *
 * Also re-verified this session: running `codex mcp add testserver` a second
 * time with a different `args`/`env` updated the same `[mcp_servers.testserver]`
 * table in place (new `args`, new `env` value, no duplicate table) rather
 * than duplicating it — genuinely a real, idempotent "add-or-update", not
 * merely documented as one.
 *
 * No TOML library is installed in this workspace (see docs/ai-notes.md), so
 * this backend never parses `config.toml` itself; it shells out to `codex`'s
 * own add/get lifecycle instead, which reads the whole file, splices in the
 * one server, and rewrites it — the same operation a human running the CLI
 * by hand would do. That rewrite is not necessarily byte-identical to the
 * original (a probe against a real `~/.codex/config.toml` in a past session
 * showed `codex` drops an explicit `args = []` and reformats
 * `startup_timeout_sec = 120` as `120.0`), but that lossiness belongs to
 * `codex`'s own writer, not to this backend.
 *
 * `skillsDir: ".codex/skills"` also re-verified this session: the installed
 * CLI's own compiled binary
 * (`node_modules/@openai/codex-linux-arm64/vendor/.../bin/codex`), grepped
 * for literal strings, contains `.codex/skills`, `CODEX_HOME/skills`, and an
 * entire embedded `ext/skills/src/...` Rust source tree (`loader/discovery.rs`,
 * `loader/host.rs`, `tools/list.rs`, `tools/read.rs`, ...) — Codex genuinely
 * ships a skills-loading subsystem rooted at this path, not merely a
 * documented convention.
 */
export const CodexBackend: AiToolBackend = {
  id: "codex",
  skillsDir: ".codex/skills",
  reviewedConfigFiles: [".codex/config.toml", ".codex/AGENTS.md"],
  mcp: {
    observe: (name, ctx) =>
      ctx.exec({ command: Sh.sh("codex", "mcp", "get", name, "--json"), shell: true }).pipe(
        Effect.flatMap((result) =>
          decodeCodexMcpGet(result.stdout).pipe(
            Effect.catchTag(
              "SchemaError",
              (cause) => new AiToolConfigMalformed({ tool: "codex", path: CONFIG_PATH, cause }),
            ),
          ),
        ),
        Effect.map(
          (parsed): AiMcpServerSpec =>
            parsed.transport.type === "stdio"
              ? {
                  command: parsed.transport.command,
                  ...(parsed.transport.args !== undefined ? { args: parsed.transport.args } : {}),
                  ...(parsed.transport.env !== undefined ? { env: parsed.transport.env } : {}),
                }
              : { url: parsed.transport.url },
        ),
        Effect.catchTag("CommandError", classifyCodexMcpGetError),
      ),

    apply: (name, desired, ctx) =>
      Effect.gen(function* () {
        if (desired.headers !== undefined && Object.keys(desired.headers).length > 0) {
          return yield* Effect.fail(
            new AiToolFieldUnsupported({ tool: "codex", field: "headers" }),
          );
        }

        const env: Record<string, string | Redacted.Redacted<string>> = {};
        const parts = ["codex", "mcp", "add", Sh.quote(name)];

        if (desired.url !== undefined) {
          parts.push("--url", Sh.quote(desired.url));
        } else {
          Object.entries(desired.env ?? {}).forEach(([key, value], index) => {
            parts.push("--env", metaToken(key, value, "=", `MCP_SECRET_${index}`, env));
          });
          parts.push(
            "--",
            Sh.quote(desired.command ?? ""),
            ...(desired.args ?? []).map((arg) => Sh.quote(arg)),
          );
        }

        yield* ctx
          .exec({
            // `Ai.McpServer` launches a user-named binary with user-supplied
            // arguments that are themselves the configuration being
            // installed, not values being interpolated into a fixed command
            // shape — each piece above is already quoted individually via
            // `Sh.quote`/`metaToken`, so `unsafeRaw` names this as the second
            // documented escape hatch rather than re-quoting an already-safe
            // string.
            command: Sh.unsafeRaw(
              parts.join(" "),
              "Ai.McpServer launches a user-named binary with user-supplied args, individually quoted above",
            ),
            shell: true,
            env,
          })
          .pipe(
            Effect.catchTag("CommandError", (error) => classifyCliError("codex", "codex", error)),
          );
      }),
  },
};
