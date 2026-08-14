import type { Exec } from "@machine-run/engine";
import type { CommandError } from "alchemy/Command";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/**
 * Every AI coding tool this repo knows the on-disk layout of, keyed the same
 * way `system-packages`' `PackageManagerId` is — a closed set so an unknown
 * id is a compile error, not a runtime surprise.
 *
 * Membership here says only "this tool's `skills/` directory and reviewed
 * config files are known" — it says nothing about MCP support. See
 * {@link AiToolBackend.mcp}, which four of these twelve actually populate.
 */
export const AiToolId = Schema.Literals([
  "claude",
  "codex",
  "cursor",
  "gemini",
  "grok",
  "copilot",
  "agents",
  "config-agents",
  "config-crush",
  "config-forge",
  "config-goose",
  "config-opencode",
]);

export type AiToolId = typeof AiToolId.Type;

/** The CLI a backend needs isn't installed, or isn't on `PATH`. */
export class AiToolCliMissing extends Data.TaggedError("AiToolCliMissing")<{
  tool: AiToolId;
  cli: string;
  cause: CommandError;
}> {
  override get message() {
    return `The ${this.tool} CLI ("${this.cli}") is not installed or not on PATH.`;
  }
}

/**
 * A tool's config file exists but its contents don't decode the way this
 * backend expects — not valid JSON, a top-level value that isn't an object,
 * or a shape `Schema` rejects.
 *
 * Raised rather than guessed through: a config file this resource doesn't
 * fully understand is never silently patched around, because "patch around
 * it" for a read-modify-write is how a hand-written server entry or an
 * unrelated top-level key gets clobbered.
 */
export class AiToolConfigMalformed extends Data.TaggedError("AiToolConfigMalformed")<{
  tool: AiToolId;
  path: string;
  cause: unknown;
}> {
  override get message() {
    return `Could not read ${this.tool}'s config at "${this.path}" as this backend expects. Inspect the file by hand before retrying — nothing here will overwrite content it cannot first understand.`;
  }
}

/**
 * This tool's MCP registration format cannot represent one of the fields a
 * recipe asked for — e.g. Codex's remote servers take a bearer-token
 * environment variable, not arbitrary headers, so a `headers` prop has
 * nowhere honest to go.
 */
export class AiToolFieldUnsupported extends Data.TaggedError("AiToolFieldUnsupported")<{
  tool: AiToolId;
  field: string;
}> {
  override get message() {
    return `${this.tool}'s MCP registration has no way to express "${this.field}". Remove it from this server's props, or pick a different tool.`;
  }
}

/** This tool has no verified MCP registration path — see {@link AiToolBackend.mcp}. */
export class AiToolMcpUnsupported extends Data.TaggedError("AiToolMcpUnsupported")<{
  tool: AiToolId;
}> {
  override get message() {
    return `${this.tool} has no verified MCP registration backend. Either it wasn't installed on the machine this was written against, or its config layout for MCP servers hasn't been grounded yet — see docs/ai-notes.md.`;
  }
}

export type AiToolError =
  | CommandError
  | PlatformError
  | AiToolCliMissing
  | AiToolConfigMalformed
  | AiToolFieldUnsupported;

/**
 * One MCP server registration, as read back from a tool's own config —
 * always fully resolved plain strings, because a live config file or CLI
 * only ever holds materialized values, never a reference to a secret store.
 */
export interface AiMcpServerSpec {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * One MCP server registration to *write*, in the tool-agnostic shape
 * `Ai.McpServer` resolves its props down to before handing them to a
 * backend's `apply`.
 *
 * `env`/`headers` values may be `Redacted` — a value sourced from a secret
 * backend stays wrapped as far into a backend's own `apply` as that backend
 * can manage, so a CLI-driven backend (see `backends/Codex.ts`) can pass it
 * straight through {@link Exec}'s `env` without its own code ever holding
 * the plaintext. A file-writing backend (see `backends/Claude.ts`) has no
 * such luxury — the file itself must hold the resolved value, exactly the
 * way `Machine.SecretFile` writes a resolved secret to disk — so it unwraps
 * at the last possible moment, immediately before serializing.
 */
export interface AiMcpServerDesired {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string | Redacted.Redacted<string>>>;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string | Redacted.Redacted<string>>>;
}

/**
 * What a backend's MCP methods are given to do their work — the union of
 * what a CLI-driven backend needs ({@link Exec}) and what a file-driven one
 * needs (`FileSystem`/`Path`, plus the resolved home directory), so one
 * interface covers both without either kind carrying a dependency it never
 * touches.
 *
 * `home` is a plain resolved string rather than the `MachinePaths` service
 * itself — every path a backend builds is a fixed location under the home
 * directory (`~/.claude.json`, `~/.codex/config.toml`, ...), never a `~`
 * prefixed value from a recipe that needs `MachinePaths.expand`'s
 * normalisation, so backends never need the service, only the one value it
 * resolves.
 */
export interface AiToolContext {
  readonly exec: Exec;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly home: string;
}

/**
 * Registers one named MCP server into a tool's own config, in whatever
 * shape that tool actually uses.
 *
 * This is the seam the rest of the package exists for: every tool stores MCP
 * servers differently — a JSON file with a `mcpServers` map (Claude Code), a
 * JSON(C) file with an `mcp` map using different field names again
 * (opencode), or a TOML table maintained through the tool's own CLI (Codex,
 * Grok) because no TOML library is available here and the tool's own
 * add/get/remove lifecycle is a real, stable, already-idempotent surface.
 * `Ai.McpServer` knows none of this — it calls whichever backend `tool`
 * names.
 */
export interface AiMcpBackend {
  /**
   * The file this tool's MCP registrations live in.
   *
   * This exists so `Ai.McpServer` can use it as its `address` — the engine
   * derives mutual exclusion and pre-overwrite snapshotting from `address`, and
   * a synthetic key like `ai-mcp-config:claude` serialises two `Ai.McpServer`
   * resources against each other while sharing nothing with a
   * `Machine.File`, `Machine.ManagedBlock` or `Machine.Template` pointed at the
   * same real file. Two resources that write one file must agree on one
   * address, and the only spelling every resource can agree on is the path.
   *
   * Narrower than `AiToolContext` on purpose: locating a config file needs a
   * home directory and a path joiner, not an `exec` or a filesystem, and
   * `address` is a pure synchronous function with no context to hand over.
   *
   * Codex and Grok mutate their TOML through the tool's own CLI rather than
   * writing the file directly, but the file is still the thing being contended
   * for, so they report it too.
   */
  readonly configFile: (home: string, path: Path.Path) => string;

  /** The server named `name`'s current registration, or `undefined` if it has none. */
  readonly observe: (
    name: string,
    ctx: AiToolContext,
  ) => Effect.Effect<AiMcpServerSpec | undefined, AiToolError>;
  /**
   * Registers `desired` under `name`, merging into whatever the tool's
   * config already holds — every other server, and every other top-level
   * key, untouched. Never a whole-file overwrite: these files also carry
   * hand-written settings and, in the same directory, `auth.json` and
   * session state this package never touches.
   */
  readonly apply: (
    name: string,
    desired: AiMcpServerDesired,
    ctx: AiToolContext,
  ) => Effect.Effect<void, AiToolError>;

  /**
   * Removes the server named `name` from this tool's config, touching only
   * that one entry — every other server and every other top-level key is
   * left exactly as `apply` leaves them. A no-op if `name` is not registered.
   */
  readonly remove: (name: string, ctx: AiToolContext) => Effect.Effect<void, AiToolError>;
}

/**
 * One AI tool's on-disk layout: where its `skills/` directory lives, which of
 * its config files have been individually reviewed as safe to symlink from a
 * vault (see `Ai.Config`), and — for the four tools this was actually
 * verified against — how it stores MCP servers.
 *
 * `mcp` is deliberately optional. A tool with no entry here was either not
 * installed on the machine this package was grounded against, or its CLI
 * offers no way to add/inspect an MCP server that could be verified — see
 * `backends/Basic.ts` and docs/ai-notes.md for exactly which and why. Nothing
 * invents a layout for tools that fall in this second group.
 */
export interface AiToolBackend {
  readonly id: AiToolId;
  /** Relative to the home directory, e.g. `.claude/skills`. */
  readonly skillsDir: string;
  /** Relative to the home directory. Empty when nothing about this tool has been reviewed as symlink-safe. */
  readonly reviewedConfigFiles: readonly string[];
  readonly mcp?: AiMcpBackend;
}
