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
 * One entry under `mcp` in opencode's config, verified by running the real,
 * installed `opencode mcp add` against an isolated `$HOME` (`opencode mcp
 * add name --url ...` and `opencode mcp add name --env K=V -- cmd args...`)
 * and reading back the resulting `opencode.jsonc`. Field names diverge from
 * every other backend here — `command` is the whole argv as one array
 * (binary and args together), and env vars are `environment`, not `env` —
 * confirming this really is a per-tool shape, not a family everyone agrees
 * on. Also present in the installed `@opencode-ai/sdk` package's own
 * `McpLocalConfig`/`McpRemoteConfig` type declarations, which corroborate
 * every field beyond what the CLI run alone exercised (`enabled`, `oauth`,
 * `timeout`).
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
 * opencode, verified directly: `opencode mcp add <name> --url ...` and
 * `opencode mcp add <name> --env K=V -- cmd args...` against an isolated
 * `$HOME`, reading back the resulting `~/.config/opencode/opencode.jsonc`.
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
