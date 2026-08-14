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
 * — verified against the real, installed `codex` CLI run with a name it has
 * never heard of. Matched case-insensitively and as a substring (real output
 * carries an `Error: ` prefix) so this narrows only the documented shape,
 * the same discipline `git/src/toplevel.ts`'s `showToplevel` uses for `git`'s
 * "not a git repository" text.
 */
const NO_SUCH_SERVER = /No MCP server named/i;

/**
 * `codex mcp get <name> --json`'s own shape, verified by running the real,
 * installed `codex` CLI against an isolated `$CODEX_HOME` and reading its
 * output. Only the two fields this backend needs are decoded — the real
 * output also carries `enabled`, `disabled_reason`, `enabled_tools`,
 * `disabled_tools`, `startup_timeout_sec`, `tool_timeout_sec`, none of which
 * this resource manages.
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
 * Codex, verified directly: `codex mcp add <name> --env K=V -- cmd args...`
 * and `codex mcp add <name> --url ...` against an isolated `$CODEX_HOME`,
 * then reading back the resulting `~/.codex/config.toml` and running
 * `codex mcp get <name> --json`.
 *
 * No TOML library is installed in this workspace (see docs/ai-notes.md), so
 * this backend never parses `config.toml` itself. It shells out to `codex`'s
 * own add/get lifecycle instead — verified to be a real, idempotent
 * "add-or-update" (`codex mcp add` on an existing name updates it in place)
 * that reads the whole file, splices in the one server, and rewrites it,
 * which is the same operation a human running the CLI by hand would do.
 * That rewrite is not byte-identical to the original — a probe against the
 * real config on this machine showed `codex` drops an explicit `args = []`
 * and reformats `startup_timeout_sec = 120` as `120.0` — but that lossiness
 * belongs to `codex`'s own writer, not to this backend; it is exactly what
 * would happen if the operator ran `codex mcp add` themselves.
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
          .exec({ command: parts.join(" "), shell: true, env })
          .pipe(
            Effect.catchTag("CommandError", (error) => classifyCliError("codex", "codex", error)),
          );
      }),
  },
};
