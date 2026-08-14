import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as UndefinedOr from "effect/UndefinedOr";
import {
  AiToolConfigMalformed,
  type AiMcpServerDesired,
  type AiMcpServerSpec,
  type AiToolBackend,
  type AiToolContext,
} from "../Backend.ts";
import {
  type JsonConfigDocument,
  jsonRecordOr,
  readJsonDocument,
  unwrapRecord,
  writeJsonDocument,
} from "./jsonConfigFile.ts";

/**
 * One entry under `mcpServers` in Claude Code's own config — re-verified this
 * session directly against the real, installed `claude` CLI
 * (`@anthropic-ai/claude-code@2.1.232`, `npm install -g
 * @anthropic-ai/claude-code` in a `node:22-slim` container, `HOME` pointed at
 * the container's own isolated `/root`, never this Mac's real `~/.claude`).
 * `claude mcp add-json testserver '{"command":"npx","args":["-y","my-mcp-server"],"env":{"API_KEY":"xxx"}}'
 * -s user` followed by `claude mcp add --transport http httptest
 * https://example.com/mcp --header "Authorization: Bearer secrettoken" -s
 * user` wrote exactly:
 * ```
 * "mcpServers": {
 *   "testserver": { "command": "npx", "args": ["-y", "my-mcp-server"], "env": { "API_KEY": "xxx" } },
 *   "httptest": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer secrettoken" } }
 * }
 * ```
 * A stdio entry really has no `type` field at all; only `http`/`sse` entries
 * carry one — this schema's shape holds up unchanged from before this
 * session's re-run.
 */
const McpServerEntry = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  url: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

type McpServerEntry = typeof McpServerEntry.Type;

const McpServers = Schema.Record(Schema.String, McpServerEntry);
const decodeMcpServers = Schema.decodeUnknownEffect(McpServers);

/**
 * `~/.claude.json` is Claude Code's whole client-side state file — onboarding
 * flags, cached feature data, per-project settings, and (at user scope, which
 * this backend always targets) `mcpServers`. Reading it as a fixed `Schema`
 * would mean re-declaring dozens of fields this package has no business
 * knowing about, and would silently drop any it got wrong. Instead only the
 * one key this backend owns is decoded; everything else round-trips as
 * opaque `Schema.Json` — read, never inspected, written back byte-for-byte.
 */
const readDocument = (configPath: string, ctx: AiToolContext) =>
  readJsonDocument("claude", configPath, ctx, {});

const writeDocument = (configPath: string, doc: JsonConfigDocument, ctx: AiToolContext) =>
  writeJsonDocument("claude", configPath, doc, ctx);

const specToEntry = (spec: AiMcpServerDesired): McpServerEntry => {
  if (spec.url !== undefined) {
    const headers = unwrapRecord(spec.headers);
    return {
      type: "http",
      url: spec.url,
      ...(headers !== undefined && Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }
  const env = unwrapRecord(spec.env);
  return {
    ...(spec.command !== undefined ? { command: spec.command } : {}),
    ...(spec.args !== undefined && spec.args.length > 0 ? { args: [...spec.args] } : {}),
    ...(env !== undefined && Object.keys(env).length > 0 ? { env } : {}),
  };
};

const entryToSpec = (entry: McpServerEntry): AiMcpServerSpec =>
  entry.url !== undefined
    ? {
        url: entry.url,
        ...(entry.headers !== undefined ? { headers: entry.headers } : {}),
      }
    : {
        ...(entry.command !== undefined ? { command: entry.command } : {}),
        ...(entry.args !== undefined ? { args: entry.args } : {}),
        ...(entry.env !== undefined ? { env: entry.env } : {}),
      };

/**
 * Claude Code, re-verified directly this session: `claude mcp add-json
 * <name> <json> -s user` and `claude mcp add --transport http ... -s user`
 * run against a real, freshly-installed `claude` CLI inside a Docker
 * container (never this Mac's real `~/.claude.json`), then reading back what
 * landed in the container's own `~/.claude.json` — see `McpServerEntry`'s
 * doc comment above for the exact commands and exact resulting JSON. User-
 * scope servers live at the document's top-level `mcpServers` key (project-
 * scope servers instead live under `projects["<cwd>"].mcpServers` in the
 * same file, or in a repo's own `.mcp.json` — this backend only ever targets
 * user scope, the one that applies machine-wide regardless of working
 * directory).
 *
 * `skillsDir: ".claude/skills"` also re-verified this session: the installed
 * CLI's own compiled binary
 * (`node_modules/@anthropic-ai/claude-code-linux-arm64/claude`), grepped for
 * literal strings, contains `.claude/skills/SKILL.md`,
 * `.claude/skills/commit/SKILL.md`, `.claude/skills/deploy/SKILL.md`, and
 * several more — this is a real, load-bearing path baked into the binary,
 * not merely documented.
 */
export const ClaudeBackend: AiToolBackend = {
  id: "claude",
  skillsDir: ".claude/skills",
  reviewedConfigFiles: [".claude/settings.json"],
  mcp: {
    observe: (name, ctx) =>
      Effect.gen(function* () {
        const configPath = ctx.path.join(ctx.home, ".claude.json");
        const doc = yield* readDocument(configPath, ctx);
        const raw = jsonRecordOr(doc.mcpServers ?? null, {});
        const servers = yield* decodeMcpServers(raw).pipe(
          Effect.catchTag(
            "SchemaError",
            (cause) => new AiToolConfigMalformed({ tool: "claude", path: configPath, cause }),
          ),
        );
        return UndefinedOr.map(servers[name], entryToSpec);
      }),

    apply: (name, desired, ctx) =>
      Effect.gen(function* () {
        const configPath = ctx.path.join(ctx.home, ".claude.json");
        const doc = yield* readDocument(configPath, ctx);
        const raw = jsonRecordOr(doc.mcpServers ?? null, {});
        yield* writeDocument(
          configPath,
          { ...doc, mcpServers: { ...raw, [name]: specToEntry(desired) } },
          ctx,
        );
      }),
  },
};
