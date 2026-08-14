import { MachinePaths } from "@machine-run/core";
import { type Reconciler, toProvider } from "@machine-run/engine";
import { readSecret, SecretSource, type SecretError } from "@machine-run/secrets";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { AiToolContext, AiToolError } from "./Backend.ts";
import { AiToolMcpUnsupported } from "./Backend.ts";
import { aiToolBackend } from "./Store.ts";

/**
 * The AI tools this package has a verified MCP registration backend for —
 * a strict subset of {@link import("./Backend.ts").AiToolId}. Restricting
 * `Ai.McpServer.tool` to these four means naming an unsupported tool is a
 * compile error, not a runtime `AiToolMcpUnsupported` — see
 * `backends/Basic.ts` for why the other eight aren't here.
 */
export const AiMcpToolId = Schema.Literals(["claude", "codex", "grok", "config-opencode"]);

export type AiMcpToolId = typeof AiMcpToolId.Type;

/**
 * One env or header value: a literal string, or a reference into a secret
 * backend resolved only at apply time.
 *
 * `Machine.SecretFile`'s doc comment lays out why this distinction has to
 * exist rather than accepting a plain string everywhere: Alchemy persists
 * props to `localState()` as unencrypted JSON, so a literal secret typed
 * directly into `env` would sit in plaintext state forever, the same hazard
 * `Machine.File.content` warns about. A literal string is still accepted —
 * plenty of MCP server env vars (`LOG_LEVEL`, `NODE_ENV`) are not secrets,
 * and forcing every one through a vault would be its own kind of friction —
 * but anything credential-shaped should use the `{ source, ref }` form
 * instead, resolved through the exact same `@machine-run/secrets` seam
 * `Machine.SecretFile` and `Tailscale.Connection` already use.
 */
export const McpEnvValue = Schema.Union([Schema.String, SecretSource]);

export type McpEnvValue = typeof McpEnvValue.Type;

export const McpServerProps = Schema.Struct({
  tool: AiMcpToolId,
  /** This server's name within the tool's own config — what `claude mcp list` etc. would show. */
  name: Schema.String,
  /** The binary to launch, for a stdio server. Mutually exclusive with `url`. */
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, McpEnvValue)),
  /** A remote server's endpoint. Mutually exclusive with `command`. */
  url: Schema.optionalKey(Schema.String),
  /** Only honoured by tools whose remote-server support takes arbitrary headers — see each backend's own doc comment. */
  headers: Schema.optionalKey(Schema.Record(Schema.String, McpEnvValue)),
});

export type McpServerProps = typeof McpServerProps.Type;

/**
 * Never carries a resolved secret value, by construction: `envLiteral` and
 * `headerLiteral` only ever hold the subset of entries whose prop value was
 * already a plain string (never secret-shaped), and `envKeys`/`headerKeys`
 * record which keys should exist without saying what any secret-sourced
 * one's value is.
 *
 * The honest consequence, the same one `Machine.SecretFileState`'s doc
 * comment states for the same reason: a secret rotated behind an unchanged
 * `ref` is undetectable by this resource, because detecting it would mean
 * comparing a resolved secret value inside `matches` — exactly what must
 * never happen. Changing *which* key exists, or any literal value, is real
 * drift and is caught; changing what a secret-sourced key's value resolves
 * to, without touching its `ref`, is not.
 */
export const McpServerState = Schema.Struct({
  tool: AiMcpToolId,
  name: Schema.String,
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  url: Schema.optionalKey(Schema.String),
  envKeys: Schema.optionalKey(Schema.Array(Schema.String)),
  envLiteral: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  headerKeys: Schema.optionalKey(Schema.Array(Schema.String)),
  headerLiteral: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

export type McpServerState = typeof McpServerState.Type;

export interface McpServer extends Resource<"Ai.McpServer", McpServerProps, McpServerState> {}

export const McpServer = Resource<McpServer>("Ai.McpServer");

const isSecretRef = (value: McpEnvValue): value is SecretSource => typeof value !== "string";

/** Every declared key, sorted — both literal and secret-sourced, since either kind existing or not existing is real drift. */
const declaredKeys = (entries: Record<string, McpEnvValue> | undefined): string[] =>
  Object.keys(entries ?? {}).sort();

/** Only the literal (non-secret) entries, by their own declared value. */
const declaredLiteral = (entries: Record<string, McpEnvValue> | undefined) =>
  Object.fromEntries(
    Object.entries(entries ?? {}).flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value] as const] : [],
    ),
  );

/**
 * Which declared keys are actually present in a live registration, and the
 * live value of each declared key that is literal in props — never the live
 * value of a secret-sourced key, which is never even read into this object.
 */
const observedKeysAndLiteral = (
  declared: Record<string, McpEnvValue> | undefined,
  live: Readonly<Record<string, string>> | undefined,
) => {
  // Only keys that are both declared and actually present count as observed;
  // a secret-sourced key contributes its presence but never its value, which
  // is why the live value is read only on the literal branch.
  const present = Object.entries(declared ?? {}).flatMap(([key, value]) =>
    live !== undefined && key in live ? [[key, value] as const] : [],
  );
  return {
    keys: present.map(([key]) => key).sort(),
    literal: Object.fromEntries(
      present.flatMap(([key, value]) =>
        isSecretRef(value) ? [] : [[key, live?.[key] ?? ""] as const],
      ),
    ),
  };
};

const arraysEqual = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean => {
  if (a === undefined || b === undefined) return a === undefined && b === undefined;
  return a.length === b.length && a.every((value, index) => value === b[index]);
};

const recordsEqual = (
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean => {
  if (a === undefined || b === undefined) return a === undefined && b === undefined;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return arraysEqual(aKeys, bKeys) && aKeys.every((key) => a[key] === b[key]);
};

export const makeMcpServerReconciler: Effect.Effect<
  Reconciler<McpServerProps, McpServerState, AiToolError | AiToolMcpUnsupported | SecretError>,
  never,
  FileSystem.FileSystem | Path.Path | MachinePaths
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* MachinePaths;

  const requireMcp = (tool: AiMcpToolId) => {
    const backend = aiToolBackend(tool);
    return backend.mcp === undefined
      ? Effect.fail(new AiToolMcpUnsupported({ tool }))
      : Effect.succeed(backend.mcp);
  };

  return {
    // Every server for one tool shares one underlying config document — two
    // different server names for the same tool still race on the same
    // read-modify-write, exactly the hazard `Dotfiles.FileLock` exists for
    // `Machine.ManagedBlock`. Sharing this address, rather than addressing
    // per server name, is what makes the engine serialise them against each
    // other instead of racing.
    address: (props) => `ai-mcp-config:${props.tool}`,

    observe: (props, ctx) =>
      Effect.gen(function* () {
        const mcp = yield* requireMcp(props.tool);
        const toolCtx: AiToolContext = { exec: ctx.exec, fs, path, home: paths.home };
        const live = yield* mcp.observe(props.name, toolCtx);
        if (live === undefined) return undefined;

        const env = observedKeysAndLiteral(props.env, live.env);
        const headers = observedKeysAndLiteral(props.headers, live.headers);

        return {
          tool: props.tool,
          name: props.name,
          ...(live.command !== undefined ? { command: live.command } : {}),
          ...(live.args !== undefined ? { args: [...live.args] } : {}),
          ...(live.url !== undefined ? { url: live.url } : {}),
          ...(env.keys.length > 0 ? { envKeys: env.keys } : {}),
          ...(Object.keys(env.literal).length > 0 ? { envLiteral: env.literal } : {}),
          ...(headers.keys.length > 0 ? { headerKeys: headers.keys } : {}),
          ...(Object.keys(headers.literal).length > 0 ? { headerLiteral: headers.literal } : {}),
        };
      }),

    desired: (props) =>
      Effect.succeed({
        tool: props.tool,
        name: props.name,
        ...(props.command !== undefined ? { command: props.command } : {}),
        ...(props.args !== undefined ? { args: [...props.args] } : {}),
        ...(props.url !== undefined ? { url: props.url } : {}),
        ...(declaredKeys(props.env).length > 0 ? { envKeys: declaredKeys(props.env) } : {}),
        ...(Object.keys(declaredLiteral(props.env)).length > 0
          ? { envLiteral: declaredLiteral(props.env) }
          : {}),
        ...(declaredKeys(props.headers).length > 0
          ? { headerKeys: declaredKeys(props.headers) }
          : {}),
        ...(Object.keys(declaredLiteral(props.headers)).length > 0
          ? { headerLiteral: declaredLiteral(props.headers) }
          : {}),
      }),

    matches: (observed, desired) =>
      observed.tool === desired.tool &&
      observed.name === desired.name &&
      observed.command === desired.command &&
      arraysEqual(observed.args, desired.args) &&
      observed.url === desired.url &&
      arraysEqual(observed.envKeys, desired.envKeys) &&
      recordsEqual(observed.envLiteral, desired.envLiteral) &&
      arraysEqual(observed.headerKeys, desired.headerKeys) &&
      recordsEqual(observed.headerLiteral, desired.headerLiteral),

    apply: ({ props, desired }, ctx) =>
      Effect.gen(function* () {
        const mcp = yield* requireMcp(props.tool);

        const resolve = (entries: Record<string, McpEnvValue> | undefined) =>
          Effect.gen(function* () {
            const out: Record<string, string | Redacted.Redacted<string>> = {};
            for (const [key, value] of Object.entries(entries ?? {})) {
              out[key] = typeof value === "string" ? value : yield* readSecret(value, ctx.exec);
            }
            return out;
          });

        const env = yield* resolve(props.env);
        const headers = yield* resolve(props.headers);

        yield* mcp.apply(
          props.name,
          {
            ...(props.command !== undefined ? { command: props.command } : {}),
            ...(props.args !== undefined ? { args: props.args } : {}),
            ...(Object.keys(env).length > 0 ? { env } : {}),
            ...(props.url !== undefined ? { url: props.url } : {}),
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
          },
          { exec: ctx.exec, fs, path, home: paths.home },
        );

        return desired;
      }),
  };
});

export const McpServerProvider = () => toProvider(McpServer, makeMcpServerReconciler);
