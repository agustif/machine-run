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

export const RuntimeManagerId = Schema.Literals(["mise", "asdf", "rustup", "uv"]);
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
 * The shared shape every runtime-version-manager backend implements —
 * `Runtime.Tool`'s one atomic seam, the same pattern as
 * `system-packages`'s `PackageManagerBackend`. `Runtime.Tool` knows nothing
 * about mise/asdf/rustup/uv specifically; it calls whichever backend's
 * `observe`/`install`/`activate` the caller selected. Adding a manager means
 * writing one small backend module, never touching the resource itself.
 *
 * Every method takes an {@link Exec} — see `PackageManagerBackend`'s doc
 * comment in `system-packages` for why: a backend never sees a session or a
 * `CommandExecutor` directly, so it cannot run a command outside the
 * reconciler's own bookkeeping.
 */
export interface RuntimeBackend {
  readonly id: RuntimeManagerId;

  /**
   * Set when this manager only ever manages one fixed tool — rustup only
   * ever manages "rust", uv only ever manages "python". `Tool.ts` checks a
   * recipe's `tool` prop against this generically, so no backend has to
   * reject a mismatched name itself and no special case lives in the
   * resource's own `observe`/`apply`.
   */
  readonly fixedTool?: string;

  /**
   * The absolute path of the file a write at `scope` reads, modifies and
   * rewrites whole. This is `Runtime.Tool`'s reconcile `address` — see its
   * doc comment for why the address has to be *this*, specifically, and not
   * a coarser stand-in like the manager's id.
   */
  readonly configPath: (scope: RuntimeScope) => string;

  /** Installed versions of `tool`, and whichever one is active at `scope`. */
  readonly observe: (
    tool: string,
    scope: RuntimeScope,
    exec: Exec,
  ) => Effect.Effect<RuntimeObservation, BackendError>;

  /** Installs `version` of `tool`. Does not touch activation at any scope. */
  readonly install: (
    tool: string,
    version: string,
    exec: Exec,
  ) => Effect.Effect<void, BackendError>;

  /** Makes `version` of `tool` the active one at `scope`. Installs it first if needed. */
  readonly activate: (
    tool: string,
    version: string,
    scope: RuntimeScope,
    exec: Exec,
  ) => Effect.Effect<void, BackendError>;
}
