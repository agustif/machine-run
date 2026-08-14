import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { CREDENTIAL_DIRECTORY_MODE, writeCredentialFileString } from "@machine-run/core";
import {
  AiToolConfigMalformed,
  type AiMcpServerDesired,
  type AiMcpServerSpec,
  type AiToolBackend,
  type AiToolContext,
  type AiToolError,
} from "../Backend.ts";

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `~/.claude.json` is Claude Code's whole client-side state file — onboarding
 * flags, cached feature data, per-project settings, and (at user scope, which
 * this backend always targets) `mcpServers`. Reading it as a fixed `Schema`
 * would mean re-declaring dozens of fields this package has no business
 * knowing about, and would silently drop any it got wrong. Instead only the
 * one key this backend owns is decoded; everything else round-trips as
 * opaque `unknown` — read, never inspected, written back byte-for-byte.
 */
const readDocument = (
  configPath: string,
  ctx: AiToolContext,
): Effect.Effect<Record<string, unknown>, AiToolError> =>
  Effect.gen(function* () {
    const present = yield* ctx.fs.exists(configPath);
    if (!present) return {};
    const text = yield* ctx.fs.readFileString(configPath);
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (cause) => new AiToolConfigMalformed({ tool: "claude", path: configPath, cause }),
    });
    if (!isRecord(parsed)) {
      return yield* Effect.fail(
        new AiToolConfigMalformed({
          tool: "claude",
          path: configPath,
          cause: "top-level JSON value is not an object",
        }),
      );
    }
    return parsed;
  });

/**
 * `mcpServers[].env` accepts `Redacted<string>` — carrying an API key into
 * this file is the documented use, not an accident — so the file is written
 * with the credential discipline rather than at the process umask.
 */
const writeDocument = (configPath: string, doc: Record<string, unknown>, ctx: AiToolContext) =>
  Effect.gen(function* () {
    yield* ctx.fs.makeDirectory(ctx.path.dirname(configPath), {
      recursive: true,
      mode: CREDENTIAL_DIRECTORY_MODE,
    });
    yield* writeCredentialFileString(ctx.fs, configPath, `${JSON.stringify(doc, null, 2)}\n`);
  });

const unwrap = (value: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const unwrapRecord = (
  values: Readonly<Record<string, string | Redacted.Redacted<string>>> | undefined,
): Record<string, string> | undefined => {
  if (values === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) out[key] = unwrap(value);
  return out;
};

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
        const raw = isRecord(doc.mcpServers) ? doc.mcpServers : {};
        const servers = yield* decodeMcpServers(raw).pipe(
          Effect.catchTag(
            "SchemaError",
            (cause) => new AiToolConfigMalformed({ tool: "claude", path: configPath, cause }),
          ),
        );
        const entry = servers[name];
        return entry === undefined ? undefined : entryToSpec(entry);
      }),

    apply: (name, desired, ctx) =>
      Effect.gen(function* () {
        const configPath = ctx.path.join(ctx.home, ".claude.json");
        const doc = yield* readDocument(configPath, ctx);
        const raw = isRecord(doc.mcpServers) ? doc.mcpServers : {};
        yield* writeDocument(
          configPath,
          { ...doc, mcpServers: { ...raw, [name]: specToEntry(desired) } },
          ctx,
        );
      }),
  },
};
