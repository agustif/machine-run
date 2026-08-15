import {
  CREDENTIAL_DIRECTORY_MODE,
  statIfPresent,
  writeCredentialFileString,
} from "@machine-run/core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { AiToolConfigMalformed, type AiToolContext, type AiToolError, type AiToolId } from "../Backend.ts";

/**
 * Shared by every backend that stores its MCP registrations in a whole JSON
 * config file it must read-modify-write — `Claude.ts` and `OpenCode.ts` today.
 * The CLI-driven backends (`Codex.ts`, `Grok.ts`) never touch a document like
 * this at all: they hand `Redacted` values straight to `Exec`'s `env` and let
 * the tool's own CLI own the file.
 *
 * A document's value type is `Schema.Json`, Effect's own recursive type for
 * any JSON-compatible value — never `unknown`. Every key a backend doesn't
 * own (onboarding flags, cached feature data, unrelated settings) round-trips
 * through here as opaque `Json`, which still rules out non-JSON values
 * (functions, symbols) at decode time, unlike a bare `unknown` escape hatch.
 */
const Document = Schema.Record(Schema.String, Schema.Json);

export type JsonConfigDocument = typeof Document.Type;

const DocumentFromString = Schema.fromJsonString(Document, { space: 2 });
const decodeDocument = Schema.decodeEffect(DocumentFromString);
const encodeDocument = Schema.encodeEffect(DocumentFromString);

/** `value` is a JSON object, as opposed to an array, a primitive, or `null`. */
export const isJsonRecord = (value: Schema.Json): value is JsonConfigDocument => {
  if (value === null) return false;
  if (Array.isArray(value)) return false;
  return typeof value === "object";
};

/** `value` when it is a JSON object, `fallback` otherwise. */
export const jsonRecordOr = (value: Schema.Json, fallback: JsonConfigDocument): JsonConfigDocument => {
  if (isJsonRecord(value)) return value;
  return fallback;
};

/**
 * Reads `configPath` as a JSON document, or `fallback` when the file doesn't
 * exist yet. Fails with `AiToolConfigMalformed` for anything that isn't valid
 * JSON or isn't an object at the top level — a config file this backend
 * doesn't fully understand is never guessed through (AGENTS.md rule 11).
 */
export const readJsonDocument = (
  tool: AiToolId,
  configPath: string,
  ctx: AiToolContext,
  fallback: JsonConfigDocument,
): Effect.Effect<JsonConfigDocument, AiToolError> =>
  Effect.gen(function* () {
    const present = yield* statIfPresent(ctx.fs, configPath, (cause) => cause);
    if (Option.isNone(present)) return fallback;
    const text = yield* ctx.fs.readFileString(configPath);
    return yield* decodeDocument(text).pipe(
      Effect.catchTag(
        "SchemaError",
        (cause) => new AiToolConfigMalformed({ tool, path: configPath, cause }),
      ),
    );
  });

/**
 * Writes `doc` back to `configPath` whole, creating its parent directory if
 * needed. Never a patch: callers merge their one owned key into `doc`
 * themselves first, so every other key and every other server round-trips
 * unchanged.
 */
export const writeJsonDocument = (
  tool: AiToolId,
  configPath: string,
  doc: JsonConfigDocument,
  ctx: AiToolContext,
): Effect.Effect<void, AiToolError> =>
  Effect.gen(function* () {
    // Every document this writes is a credential store by design: the MCP
    // `env`/`headers` records below accept a `Redacted<string>` precisely so a
    // recipe can put an API key in one. An unmoded write creates at the process
    // umask — 0644 on a default machine — so the mode goes here, in the one
    // place both file-backed AI backends share, rather than being remembered
    // per backend. `writeCredentialFileString` carries the other half: the OS
    // applies a write's mode only on *creation*, so a config some other tool
    // already created world-readable needs the explicit chmod too.
    yield* ctx.fs.makeDirectory(ctx.path.dirname(configPath), {
      recursive: true,
      mode: CREDENTIAL_DIRECTORY_MODE,
    });
    const encoded = yield* encodeDocument(doc).pipe(
      Effect.catchTag(
        "SchemaError",
        (cause) => new AiToolConfigMalformed({ tool, path: configPath, cause }),
      ),
    );
    yield* writeCredentialFileString(ctx.fs, configPath, `${encoded}\n`);
  });

/**
 * A secret-or-plain value, resolved to plain text immediately before it is
 * serialized to disk. A file-writing backend has no way to keep a value
 * `Redacted` the way a CLI-driven backend can (see `AiMcpServerDesired`'s doc
 * comment in `Backend.ts`): the config file itself must hold the resolved
 * bytes, exactly as `Machine.SecretFile` does.
 */
export const unwrap = (value: string | Redacted.Redacted<string>): string => {
  if (Redacted.isRedacted(value)) return Redacted.value(value);
  return value;
};

export const unwrapRecord = (
  values: Readonly<Record<string, string | Redacted.Redacted<string>>> | undefined,
): Record<string, string> | undefined => {
  if (values === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) out[key] = unwrap(value);
  return out;
};
