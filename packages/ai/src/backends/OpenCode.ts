import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
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
/** The file this backend's registrations live in — also this resource's
 * `address`, so a `Machine.File` on the same path shares its lock. */
const configFile = (home: string, path: Path.Path) =>
  path.join(home, ".config/opencode/opencode.jsonc");

const readDocument = (configPath: string, ctx: AiToolContext) =>
  readJsonDocument("config-opencode", configPath, ctx, {
    $schema: "https://opencode.ai/config.json",
  });

const writeDocument = (configPath: string, doc: JsonConfigDocument, ctx: AiToolContext) =>
  writeJsonDocument("config-opencode", configPath, doc, ctx);

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
    configFile,

    observe: (name, ctx) =>
      Effect.gen(function* () {
        const configPath = configFile(ctx.home, ctx.path);
        const doc = yield* readDocument(configPath, ctx);
        const raw = jsonRecordOr(doc.mcp ?? null, {});
        const servers = yield* decodeMcpServers(raw).pipe(
          Effect.catchTag(
            "SchemaError",
            (cause) =>
              new AiToolConfigMalformed({ tool: "config-opencode", path: configPath, cause }),
          ),
        );
        return UndefinedOr.map(servers[name], entryToSpec);
      }),

    apply: (name, desired, ctx) =>
      Effect.gen(function* () {
        const configPath = configFile(ctx.home, ctx.path);
        const doc = yield* readDocument(configPath, ctx);
        const raw = jsonRecordOr(doc.mcp ?? null, {});
        yield* writeDocument(
          configPath,
          { ...doc, mcp: { ...raw, [name]: specToEntry(desired) } },
          ctx,
        );
      }),
  },
};
