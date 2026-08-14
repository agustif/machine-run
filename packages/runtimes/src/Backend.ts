import type * as Duration from "effect/Duration";
import type { CommandError } from "alchemy/Command";
import type { Exec } from "@machine-run/engine";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";

export class BackendParseError extends Data.TaggedError("BackendParseError")<{
  manager: string;
  cause: unknown;
}> {
  override get message() {
    return `Could not parse ${this.manager}'s output. This usually means the CLI's output format changed, or it printed a warning where machine-run expected only data.`;
  }
}

/**
 * `PlatformError` joins the union for exactly one backend (`uv`, which reads
 * its own pin file with `FileSystem` rather than shelling out — see
 * `backends/Uv.ts`'s doc comment). mise/asdf/rustup never produce one; the
 * type is shared so `Runtime.Tool`'s reconciler has one error channel for
 * every backend rather than a per-manager union computed from whichever
 * happens to be wired in.
 */
export type BackendError = CommandError | BackendParseError | PlatformError;

/**
 * Every runtime version manager this repo knows how to drive — spelled the
 * same as the `_tag` each {@link RuntimeToolProps}/`RuntimeToolState` case
 * (in `Tool.ts`) already carries. This literal set is used only for a
 * backend's own self-identifying `id` field (the same convention
 * `PackageManagerBackend`/`SettingsBackend` use); the actual dispatch between
 * managers is the tagged union itself, matched exhaustively in `Tool.ts`, not
 * a lookup keyed by this id.
 */
export const RuntimeManagerId = Schema.Literals(["Mise", "Asdf", "Rustup", "Uv"]);
export type RuntimeManagerId = typeof RuntimeManagerId.Type;

/**
 * Where a runtime is activated. Every backend here can make a version the
 * active one two ways: for the whole machine (mise/asdf's "global", rustup's
 * "default", uv's global pin), or for one directory and everything under it
 * (a project's `mise.toml`/`.tool-versions`/`.python-version`, or a rustup
 * directory override). "Active" is always resolved with respect to *one* of
 * these — there is no third "whichever one happens to apply right now"
 * scope, because that would make the very question this resource answers
 * (is the right version active) depend on which directory happened to be the
 * current one when it was asked.
 */
export const RuntimeScope = Schema.TaggedUnion({
  Global: {},
  Directory: { path: Schema.String },
});
export type RuntimeScope = typeof RuntimeScope.Type;

/**
 * What one backend command reports about one tool at one scope.
 *
 * `installed` and `active` are kept apart deliberately — see `Tool.ts`'s doc
 * comment for why conflating them was the wrong model. `active` can name a
 * version that is *not* in `installed`: a pin file surviving `asdf uninstall`
 * is a real, observed state (verified directly — see `docs/runtime-notes.md`),
 * not a bug to normalize away before it reaches the reconciler.
 */
export interface RuntimeObservation {
  /** Every concrete version of `tool` currently installed, in the manager's own form — never a fuzzy request. */
  readonly installed: ReadonlyArray<string>;
  /** The concrete version active at `scope`, or `undefined` if the manager reports none. */
  readonly active: string | undefined;
}

/**
 * What identifies *which* tool, at which requested version, mise is being
 * asked about. `tool` is looked up by membership in mise's own namespace
 * (`"node"`, `"python"`, …) — the same choice `PackageManagerBackend.name`
 * makes for package managers, deliberately with no cross-manager name
 * mapping. `version` is a request (`"22"`, `"22.11"`, `"22.11.0"`), resolved
 * by `versionSatisfies` (`version.ts`), not equality — every backend already
 * resolves the identical shorthand itself (`mise use node@22`).
 */
export const MiseToolIdentity = Schema.Struct({ tool: Schema.String, version: Schema.String });
export type MiseToolIdentity = typeof MiseToolIdentity.Type;

/**
 * Identical shape to {@link MiseToolIdentity}, kept as its own schema rather
 * than reused: asdf's `tool` lives in asdf's own namespace, not mise's
 * (`"nodejs"`, not `"node"` — see `Tool.ts`'s doc comment), so the two are
 * different values under the same shape, not the same value read twice.
 */
export const AsdfToolIdentity = Schema.Struct({ tool: Schema.String, version: Schema.String });
export type AsdfToolIdentity = typeof AsdfToolIdentity.Type;

/**
 * rustup manages exactly one toolchain — Rust — so there is no `tool` field
 * to get wrong: {@link RuntimeToolProps}'s `Rustup` case (`Tool.ts`) has no
 * way to name anything else in the first place. `channel` (not `version`) is
 * deliberate: rustup's own vocabulary — `rustup toolchain install`,
 * `rustup default`, `rustup override set`, all verified directly — takes a
 * *channel* (`stable`, `beta`, `nightly`) or a pinned version like `1.79`,
 * which `rustup show` calls a "toolchain" once resolved, never a "version"
 * the way mise/asdf/uv do.
 */
export const RustupToolIdentity = Schema.Struct({ channel: Schema.String });
export type RustupToolIdentity = typeof RustupToolIdentity.Type;

/**
 * uv manages exactly one toolchain — Python — so there is no `tool` field
 * either, for the identical reason {@link RustupToolIdentity} has none.
 * `version` (not `channel`) here because `uv python install`/`pin` take a
 * Python version (`"3.12"`), never a channel name — verified via `uv python
 * --help`.
 */
export const UvToolIdentity = Schema.Struct({ version: Schema.String });
export type UvToolIdentity = typeof UvToolIdentity.Type;

/**
 * The shared shape every runtime-version-manager backend implements —
 * `Runtime.Tool`'s one atomic seam, the same pattern as
 * `system-packages`'s `PackageManagerBackend`. `Runtime.Tool` knows nothing
 * about mise/asdf/rustup/uv specifically; it calls whichever backend's
 * `observe`/`install`/`activate` the caller selected. Adding a manager means
 * writing one small backend module, never touching the resource itself.
 *
 * Parametrized over `Identity` — one of {@link MiseToolIdentity}, {@link
 * AsdfToolIdentity}, {@link RustupToolIdentity} or {@link UvToolIdentity} —
 * rather than a bare `tool: Schema.String`. This is what makes a runtime
 * name check impossible to need: `makeRustupBackend`
 * and `makeUvBackend` return a `RuntimeBackend<RustupToolIdentity>`/
 * `RuntimeBackend<UvToolIdentity>`, whose `Identity` has no `tool` field at
 * all, so there is no mismatched name a caller could hand them in the first
 * place — the illegal combination is unrepresentable, not merely rejected at
 * runtime. See `Tool.ts`'s doc comment on `RuntimeToolProps` for the full
 * reasoning.
 *
 * Every method takes an {@link Exec} — see `PackageManagerBackend`'s doc
 * comment in `system-packages` for why: a backend never sees a session or a
 * `CommandExecutor` directly, so it cannot run a command outside the
 * reconciler's own bookkeeping.
 */
/**
 * How long this runtime manager's work is allowed to take, declared by the
 * backend for the same reason `system-packages`' `PackageTimeouts` is: `rustup`
 * downloads a prebuilt toolchain, `mise` may build a language from source, `uv`
 * resolves a Python. Only the tool knows.
 */
export interface RuntimeTimeouts {
  /** Installing or activating a version. */
  readonly install: Duration.Input;
}

export interface RuntimeBackend<Identity> {
  readonly timeouts: RuntimeTimeouts;
  readonly id: RuntimeManagerId;

  /**
   * The absolute path of the file a write at `scope` reads, modifies and
   * rewrites whole. This is `Runtime.Tool`'s reconcile `address` — see its
   * doc comment for why the address has to be *this*, specifically, and not
   * a coarser stand-in like the manager's id.
   */
  readonly configPath: (scope: RuntimeScope) => string;

  /** Installed versions of the identified tool, and whichever one is active at `scope`. */
  readonly observe: (
    identity: Identity,
    scope: RuntimeScope,
    exec: Exec,
  ) => Effect.Effect<RuntimeObservation, BackendError>;

  /** Installs the identified tool's requested version. Does not touch activation at any scope. */
  readonly install: (identity: Identity, exec: Exec) => Effect.Effect<void, BackendError>;

  /** Makes the identified tool's requested version the active one at `scope`. Installs it first if needed. */
  readonly activate: (
    identity: Identity,
    scope: RuntimeScope,
    exec: Exec,
  ) => Effect.Effect<void, BackendError>;
}
