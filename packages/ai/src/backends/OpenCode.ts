import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  AiToolConfigMalformed,
  type AiMcpServerDesired,
  type AiMcpServerSpec,
  type AiToolBackend,
  type AiToolContext,
  type AiToolError,
} from "../Backend.ts";

/**
 * One entry under `mcp` in opencode's config, re-verified this session
 * directly against the real, installed `opencode` CLI
 * (`opencode-ai@1.18.18`, `npm install -g opencode-ai` in a `node:22-slim`
 * container, `HOME` pointed at the container's own isolated `/root`, never
 * this Mac's real `~/.config/opencode`). `opencode mcp add httptest --url
 * https://example.com/mcp` and `opencode mcp add testlocal --env
 * API_KEY=xxx -- npx -y my-mcp-server` wrote, into
 * `~/.config/opencode/opencode.jsonc`:
 * ```
 * "mcp": {
 *   "httptest": { "type": "remote", "url": "https://example.com/mcp" },
 *   "testlocal": { "type": "local", "command": ["npx", "-y", "my-mcp-server"], "environment": { "API_KEY": "xxx" } }
 * }
 * ```
 * `opencode mcp add secured --url https://mcp.example.com/mcp --header
 * "Authorization=Bearer secrettoken"` then confirmed the `remote` arm's
 * `headers` field too — real output `{ "type": "remote", "url": ...,
 * "headers": { "Authorization": "Bearer secrettoken" } }`. (Note: opencode's
 * own `--header` flag takes `KEY=VALUE`, not `KEY: VALUE` like Claude/Grok's
 * — irrelevant to this backend, which never shells out to `opencode` at all,
 * but worth knowing if a future change makes it CLI-driven.)
 *
 * Field names diverge from every other backend here — `command` is the
 * whole argv as one array (binary and args together), and env vars are
 * `environment`, not `env` — confirming this really is a per-tool shape, not
 * a family everyone agrees on. Also present in the installed
 * `@opencode-ai/sdk` package's own `McpLocalConfig`/`McpRemoteConfig` type
 * declarations, which corroborate every field beyond what the CLI run alone
 * exercised (`enabled`, `oauth`, `timeout`).
 */
const McpEntry = Schema.Struct({
  type: Schema.Literals(["local", "remote"]),
  command: Schema.optionalKey(Schema.Array(Schema.String)),
  environment: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  url: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

type McpEntry = typeof McpEntry.Type;

const McpServers = Schema.Record(Schema.String, McpEntry);
const decodeMcpServers = Schema.decodeUnknownEffect(McpServers);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `opencode.jsonc` is JSON-with-comments by name, but the real file on this
 * machine (`~/.config/opencode/opencode.jsonc`) contains none, and this
 * backend parses it as plain JSON. A config that genuinely uses `//` or
 * `/* *\/` comments fails to decode with a typed `AiToolConfigMalformed`
 * rather than having its comments silently eaten by a hand-rolled stripper —
 * this workspace has no JSONC-aware parser installed, and guessing at one is
 * exactly the kind of "patch around it" AGENTS.md rule 11 rules out. See
 * docs/ai-notes.md.
 */
const readDocument = (
  configPath: string,
  ctx: AiToolContext,
): Effect.Effect<Record<string, unknown>, AiToolError> =>
  Effect.gen(function* () {
    const present = yield* ctx.fs.exists(configPath);
    if (!present) return { $schema: "https://opencode.ai/config.json" };
    const text = yield* ctx.fs.readFileString(configPath);
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (cause) =>
        new AiToolConfigMalformed({ tool: "config-opencode", path: configPath, cause }),
    });
    if (!isRecord(parsed)) {
      return yield* Effect.fail(
        new AiToolConfigMalformed({
          tool: "config-opencode",
          path: configPath,
          cause: "top-level JSON value is not an object",
        }),
      );
    }
    return parsed;
  });

const writeDocument = (configPath: string, doc: Record<string, unknown>, ctx: AiToolContext) =>
  Effect.gen(function* () {
    yield* ctx.fs.makeDirectory(ctx.path.dirname(configPath), { recursive: true });
    yield* ctx.fs.writeFileString(configPath, `${JSON.stringify(doc, null, 2)}\n`);
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

const specToEntry = (spec: AiMcpServerDesired): McpEntry => {
  if (spec.url !== undefined) {
    const headers = unwrapRecord(spec.headers);
    return {
      type: "remote",
      url: spec.url,
      ...(headers !== undefined && Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }
  const environment = unwrapRecord(spec.env);
  return {
    type: "local",
    command: [...(spec.command !== undefined ? [spec.command] : []), ...(spec.args ?? [])],
    ...(environment !== undefined && Object.keys(environment).length > 0 ? { environment } : {}),
  };
};

const entryToSpec = (entry: McpEntry): AiMcpServerSpec =>
  entry.type === "remote"
    ? {
        ...(entry.url !== undefined ? { url: entry.url } : {}),
        ...(entry.headers !== undefined ? { headers: entry.headers } : {}),
      }
    : {
        ...(entry.command !== undefined && entry.command.length > 0
          ? { command: entry.command[0], args: entry.command.slice(1) }
          : {}),
        ...(entry.environment !== undefined ? { env: entry.environment } : {}),
      };

/**
 * opencode, re-verified this session directly: `opencode mcp add <name>
 * --url ...` and `opencode mcp add <name> --env K=V -- cmd args...` against
 * an isolated `$HOME` inside a Docker container, reading back the resulting
 * `~/.config/opencode/opencode.jsonc` — see `McpEntry`'s doc comment above
 * for the exact commands and exact resulting JSON.
 *
 * `skillsDir: ".config/opencode/skills"` also re-verified this session, and
 * less directly than the other three tools: the installed CLI's own
 * compiled binary (`node_modules/opencode-linux-arm64/bin/opencode`),
 * grepped for literal strings, contains a bundled help/doc table row reading
 * `| Global skills | ~/.config/opencode/skill(s)/<name>/SKILL.md |` —
 * confirming this is the tool's own documented global skills path, not a
 * convention this package guessed at. The same binary also contains a
 * *separate*, project-local default of `.opencode/skills` (relative to a
 * project root, the direct analogue of `.claude/skills` at repo root, not
 * this backend's `~/.config/opencode/skills` concern) — the two are
 * additive, not conflicting: one is the project-scoped lookup, the other is
 * the user-global one this backend's `skillsDir` names.
 */
export const OpenCodeBackend: AiToolBackend = {
  id: "config-opencode",
  skillsDir: ".config/opencode/skills",
  reviewedConfigFiles: [],
  mcp: {
    observe: (name, ctx) =>
      Effect.gen(function* () {
        const configPath = ctx.path.join(ctx.home, ".config/opencode/opencode.jsonc");
        const doc = yield* readDocument(configPath, ctx);
        const raw = isRecord(doc.mcp) ? doc.mcp : {};
        const servers = yield* decodeMcpServers(raw).pipe(
          Effect.catchTag(
            "SchemaError",
            (cause) =>
              new AiToolConfigMalformed({ tool: "config-opencode", path: configPath, cause }),
          ),
        );
        const entry = servers[name];
        return entry === undefined ? undefined : entryToSpec(entry);
      }),

    apply: (name, desired, ctx) =>
      Effect.gen(function* () {
        const configPath = ctx.path.join(ctx.home, ".config/opencode/opencode.jsonc");
        const doc = yield* readDocument(configPath, ctx);
        const raw = isRecord(doc.mcp) ? doc.mcp : {};
        yield* writeDocument(
          configPath,
          { ...doc, mcp: { ...raw, [name]: specToEntry(desired) } },
          ctx,
        );
      }),
  },
};
