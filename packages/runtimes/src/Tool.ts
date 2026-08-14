import { MachinePaths } from "@machine-run/core";
import {
  type ApplyContext,
  type Exec,
  type ObserveContext,
  type Reconciler,
  toProvider,
} from "@machine-run/engine";
import { Resource } from "alchemy/Resource";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { makeAsdfBackend } from "./backends/Asdf.ts";
import { makeMiseBackend } from "./backends/Mise.ts";
import { makeRustupBackend } from "./backends/Rustup.ts";
import { makeUvBackend } from "./backends/Uv.ts";
import {
  type AsdfToolIdentity,
  type BackendError,
  type MiseToolIdentity,
  type RuntimeObservation,
  RuntimeManagerId,
  RuntimeScope,
  type RustupToolIdentity,
  type UvToolIdentity,
} from "./Backend.ts";
import { versionSatisfies } from "./version.ts";

/**
 * A language runtime, at a version, installed and — unless {@link active} is
 * explicitly turned off — active at {@link scope}.
 *
 * ## Why this is not `System.Package` with a version field
 *
 * `System.Package` answers a membership question: is `ripgrep` in the
 * manager's installed set. A runtime answers two different questions that
 * happen to share a manager: is *a version satisfying this request* installed
 * anywhere, and is it *the one currently in effect*. mise can have Node
 * 20, 22 and 24 all installed with 22 active globally and 24 active inside
 * one project directory — three true, independent facts, not one boolean.
 * Collapsing them into a single "is it there" check (as `System.Package`
 * does) would make "installed but not active" and "active but somehow not
 * installed" (a real, observed state — see `backends/Asdf.ts`) indistinguishable
 * from either "fully converged" or "absent". This resource keeps the two
 * facts apart in both {@link RuntimeToolState} and in `matches`, rather than
 * quietly picking one.
 *
 * ## One case per manager, not `{ manager, tool }`
 *
 * One case per manager, because the managers are not the same shape. rustup
 * manages exactly one toolchain and uv exactly one, so their cases carry no
 * `tool` field for a caller to get wrong; only `Mise` and `Asdf` have one,
 * because only they manage more than one thing. Naming a tool for rustup is a
 * compile error rather than something a runtime check has to catch on every
 * `observe` and `apply`. `Rustup`'s identifying
 * field is `channel`, not `version` — rustup's own vocabulary (`rustup
 * toolchain install`, `rustup default`, `rustup override set`) takes a
 * *channel* (`stable`, `beta`, `nightly`) or a pinned version like `1.79`,
 * a different concept from mise/asdf/uv's `version`, which is why it gets a
 * different field name rather than reusing `version` for something that
 * isn't one. See `Backend.ts`'s `MiseToolIdentity`/`AsdfToolIdentity`/
 * `RustupToolIdentity`/`UvToolIdentity` for the identity shape each backend
 * actually receives — never a bare `tool: Schema.String` a caller could hand
 * to the wrong manager.
 *
 * ## Versions are requests, not names
 *
 * `tool` (on `Mise`/`Asdf`) is looked up by membership, the same way
 * `System.Package.name` is — whatever string the backend's own namespace
 * uses (`"node"` for mise, `"nodejs"` for asdf; there is deliberately no
 * cross-manager name mapping, for the same reason `PackageManagerBackend`
 * has none). `version`/`channel` are different: they are a request, not a
 * name, and `matches` resolves them with {@link versionSatisfies} — a
 * dotted-prefix rule, not equality — because every backend already resolves
 * the identical shorthand itself (`mise use node@22`, `asdf install nodejs
 * 22`, `uv python pin 3.12`). See `version.ts` for the exact rule and why it
 * stops short of full semver ranges.
 *
 * ## `scope` and the shared-file lock
 *
 * `mise use --global` rewrites one shared `~/.config/mise/config.toml`, so two
 * `Runtime.Tool` resources for *different* tools on the same manager at the
 * same scope contend for the same file — the read-modify-write hazard
 * `@machine-run/core`'s `FileLock` exists for (see `ManagedBlock.ts`'s doc
 * comment for the git-config/ssh-config precedent). `address` is therefore
 * each backend's `configPath(scope)` — the literal file a write at that scope
 * touches — not a coarser id like the manager alone (`System.Package`'s
 * choice, justified there because `dpkg` really does hold one lock for every
 * package regardless of name) and not a finer one like `manager:tool`
 * (wrong here, because it would let two *different* tools' writes to the
 * *same* file race). This also means directory scopes on mise/asdf/uv, which
 * each write their own per-directory file, do **not** contend with the global
 * scope or with each other's directories — but every rustup scope, global and
 * every directory override alike, funnels into one `~/.rustup/settings.toml`,
 * so `backends/Rustup.ts`'s `configPath` ignores `scope` entirely and every
 * rustup `Runtime.Tool` shares one lock. The address is a fact about the
 * manager's own file layout, not a policy this resource imposes uniformly.
 */
const scopeAndActiveFields = {
  /** Where this is activated. Defaults to {@link RuntimeScope}'s `Global` case. */
  scope: Schema.optionalKey(RuntimeScope),
  /** Whether this version must also be the *active* one at `scope`, versus merely installed. Defaults to `true`. */
  active: Schema.optionalKey(Schema.Boolean),
};

export const RuntimeToolProps = Schema.TaggedUnion({
  Mise: {
    /** The tool's name in mise's own namespace, e.g. `"node"`. */
    tool: Schema.String,
    /** A version request: `"22"`, `"22.11"`, or `"22.11.0"`. See {@link versionSatisfies}. */
    version: Schema.String,
    ...scopeAndActiveFields,
  },
  Asdf: {
    /** The tool's name in asdf's own namespace, e.g. `"nodejs"` (not `"node"`). */
    tool: Schema.String,
    /** A version request: `"22"`, `"22.11"`, or `"22.11.0"`. See {@link versionSatisfies}. */
    version: Schema.String,
    ...scopeAndActiveFields,
  },
  Rustup: {
    /** A channel request: `"stable"`, `"beta"`, `"nightly"`, or a pinned version like `"1.79"`. Not a `version` — see this module's doc comment. */
    channel: Schema.String,
    ...scopeAndActiveFields,
  },
  Uv: {
    /** A Python version request: `"3.12"`, `"3.12.1"`. */
    version: Schema.String,
    ...scopeAndActiveFields,
  },
});
export type RuntimeToolProps = typeof RuntimeToolProps.Type;

/**
 * `version` is always the concrete, resolved version (or, for `Rustup`, the
 * resolved toolchain name) a backend reported — never the fuzzy request
 * `props.version`/`props.channel` may have been. `installed` and `active` are
 * kept apart rather than folded into one boolean; see this module's doc
 * comment for why both independently matter.
 *
 * Unlike {@link RuntimeToolProps}, this stays one flat `Schema.Struct` rather
 * than a matching `Schema.TaggedUnion` — tried directly and reverted, not a
 * stylistic choice. Alchemy's `Resource<Type, Props, Attributes>` maps every
 * `Attributes` key through `{ [attr in keyof Attributes]-?: AttrOutput<...> }`
 * (`alchemy/src/Resource.ts`), and that mapped type does not resolve to a
 * plain object when `Attributes` is a union — TypeScript then refuses to let
 * `RuntimeTool` extend `Resource<...>` at all ("An interface can only extend
 * an object type ... with statically known members"), independent of whether
 * the union's members share every key. Verified directly against this
 * project's actual `alchemy` version, not assumed from the error text: a
 * throwaway `Resource<"X", Struct, TaggedUnion>` reproduces the identical
 * failure even when every case of the union shares the same fields. `Props`
 * has no such mapped type (`ResourceLike.Props` is a plain field), which is
 * why *it* could become a `TaggedUnion` and this could not — see rule 1 in
 * `AGENTS.md`: alchemy is a dependency to work within, not to fork.
 *
 * `manager` (not `_tag`) carries which case this is, spelled with
 * {@link RuntimeManagerId} — the same four names `RuntimeToolProps`'s cases
 * use, so `manager` and `tool` here always describe a state the reconciler
 * itself produced (never a recipe-authored value), which is what makes a
 * plain optional `tool` acceptable here even though the identical shape was
 * the smoking gun on `RuntimeToolProps`: nothing outside this module ever
 * constructs a `RuntimeToolState` by hand.
 */
export const RuntimeToolState = Schema.Struct({
  manager: RuntimeManagerId,
  /** Only set for `manager: "Mise"`/`"Asdf"` — `"Rustup"`/`"Uv"` have no tool dimension, see `RuntimeToolProps`. */
  tool: Schema.optionalKey(Schema.String),
  scope: RuntimeScope,
  version: Schema.String,
  installed: Schema.Boolean,
  active: Schema.Boolean,
});
export type RuntimeToolState = typeof RuntimeToolState.Type;

export interface RuntimeTool extends Resource<"Runtime.Tool", RuntimeToolProps, RuntimeToolState> {}

export const RuntimeTool = Resource<RuntimeTool>("Runtime.Tool");

/**
 * Raised when `install` and (if requested) `activate` both ran without error,
 * yet a fresh observation still finds nothing satisfying the request. This
 * should not happen against a well-behaved backend — it means the manager
 * reported success while leaving the machine in a state its own listing
 * command doesn't recognize — and is surfaced rather than silently retried or
 * guessed past, per rule 11 in `AGENTS.md`.
 *
 * Carries the whole `props` rather than separate name and version fields,
 * because the identifying field differs by case — `Rustup` has `channel`, not
 * `tool`/`version` — and `Match.tagsExhaustive` below is what makes a future
 * fifth manager a compile error here rather than a silently-wrong message.
 */
export class RuntimeNotConverged extends Data.TaggedError("RuntimeNotConverged")<{
  props: RuntimeToolProps;
}> {
  override get message() {
    const describe = Match.value(this.props).pipe(
      Match.tagsExhaustive({
        Mise: (p) => `mise reported "${p.tool}@${p.version}" installed`,
        Asdf: (p) => `asdf reported "${p.tool}@${p.version}" installed`,
        Rustup: (p) => `rustup reported "${p.channel}" installed`,
        Uv: (p) => `uv reported Python "${p.version}" installed`,
      }),
    );
    return `${describe}, but a fresh observation still can't find a version satisfying that request. The manager's own listing command disagrees with its install/activate commands.`;
  }
}

/**
 * An environment variable that may not be set, read through `effect/Config`
 * rather than `process.env` — `oxlint-plugin-effect`'s `noGlobals` rule is
 * `error`-tier here (see `docs/LINTING.md`), and `Config` is its documented
 * replacement. Each backend's `configPath` still has to be a synchronous
 * function (the `Reconciler.address` contract allows no `Effect`), so this is
 * resolved once, here, at reconciler-construction time, and closed over by
 * the plain string each backend factory receives — not re-read per call.
 */
const optionalEnv = (name: string): Effect.Effect<string | undefined> =>
  Config.string(name).pipe(
    Config.option,
    Effect.map(Option.getOrUndefined),
    // `Config.option` folds "not set" into `None`, but its declared error
    // channel is still `ConfigError` (a different provider failure is
    // structurally possible). Every one of these four variables is an
    // optional, best-effort override — treating any residual failure as
    // "not set" is the honest reading for this specific case, not a general
    // license to swallow errors.
    Effect.orElseSucceed(() => undefined),
  );

const resolveScope = (props: RuntimeToolProps): RuntimeScope => props.scope ?? { _tag: "Global" };

const scopeEquals = (a: RuntimeScope, b: RuntimeScope): boolean => {
  if (a._tag !== b._tag) return false;
  return a._tag === "Directory" && b._tag === "Directory" ? a.path === b.path : true;
};

/**
 * Whether anything a backend reported satisfies `requested`, and if so,
 * which concrete string to report as `version` — the active one winning over
 * a merely-installed one when both would do, so reporting a different
 * (older or newer) installed version here never makes `matches` reject an
 * already-satisfied request and force a pointless reactivation. Manager-
 * agnostic: every backend's {@link RuntimeObservation} already reduces to the
 * same two facts, whether the underlying concept is a version or a channel.
 */
const resolveVersion = (requested: string, observation: RuntimeObservation): string | undefined => {
  // Returned from inside each narrowing check rather than computed up front and
  // selected afterwards. The previous shape held the answer in an
  // `activeSatisfies` boolean, which carries no type evidence, so both branches
  // needed `as string` to re-assert what the boolean already implied. Checking
  // and returning in the same statement lets the compiler see it.
  if (observation.active !== undefined && versionSatisfies(requested, observation.active)) {
    return observation.active;
  }
  return observation.installed.find((candidate) => versionSatisfies(requested, candidate));
};

/**
 * Everything the shared `observe`/`desired`/`apply` logic below needs from
 * one manager's case of {@link RuntimeToolProps}, built once per call by
 * {@link planFor}'s `Match.tagsExhaustive`. Factoring this out is what keeps
 * `observe`/`apply` themselves manager-agnostic — written once, not once per
 * case — while every manager-specific detail (which backend, which identity
 * shape, which field names the state case carries) stays behind a closure
 * built in exactly one place.
 */
interface ToolPlan {
  readonly requestedVersion: string;
  readonly desiredState: RuntimeToolState;
  readonly observe: (exec: Exec) => Effect.Effect<RuntimeObservation, BackendError>;
  readonly install: (exec: Exec) => Effect.Effect<void, BackendError>;
  readonly activate: (exec: Exec) => Effect.Effect<void, BackendError>;
  readonly toObservedState: (version: string, observation: RuntimeObservation) => RuntimeToolState;
  /** Whether `state` names the same tool this plan is for — same `manager`, and same `tool` on `Mise`/`Asdf`. */
  readonly sameIdentity: (state: RuntimeToolState) => boolean;
}

export const makeRuntimeToolReconciler: Effect.Effect<
  Reconciler<RuntimeToolProps, RuntimeToolState, BackendError | RuntimeNotConverged>,
  never,
  MachinePaths | FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const paths = yield* MachinePaths;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  const miseGlobalConfigOverride = yield* optionalEnv("MISE_GLOBAL_CONFIG_FILE");
  const asdfFilenameOverride = yield* optionalEnv("ASDF_TOOL_VERSIONS_FILENAME");
  const rustupHomeOverride = yield* optionalEnv("RUSTUP_HOME");
  const uvConfigDirOverride = yield* optionalEnv("XDG_CONFIG_HOME");

  const backends = {
    mise: makeMiseBackend({
      home: paths.home,
      path,
      globalConfigOverride: miseGlobalConfigOverride,
    }),
    asdf: makeAsdfBackend({ home: paths.home, path, filenameOverride: asdfFilenameOverride }),
    rustup: makeRustupBackend({ home: paths.home, path, rustupHomeOverride }),
    uv: makeUvBackend({ home: paths.home, path, fs, configDirOverride: uvConfigDirOverride }),
  };

  const planFor = (props: RuntimeToolProps): ToolPlan =>
    Match.value(props).pipe(
      Match.tagsExhaustive({
        Mise: (p): ToolPlan => {
          const scope = resolveScope(p);
          const identity: MiseToolIdentity = { tool: p.tool, version: p.version };
          return {
            requestedVersion: p.version,
            desiredState: {
              manager: "Mise",
              tool: p.tool,
              version: p.version,
              scope,
              installed: true,
              active: p.active ?? true,
            },
            observe: (exec) => backends.mise.observe(identity, scope, exec),
            install: (exec) => backends.mise.install(identity, exec),
            activate: (exec) => backends.mise.activate(identity, scope, exec),
            toObservedState: (version, observation) => ({
              manager: "Mise",
              tool: p.tool,
              version,
              scope,
              installed: observation.installed.includes(version),
              active: observation.active === version,
            }),
            sameIdentity: (state) => state.manager === "Mise" && state.tool === p.tool,
          };
        },
        Asdf: (p): ToolPlan => {
          const scope = resolveScope(p);
          const identity: AsdfToolIdentity = { tool: p.tool, version: p.version };
          return {
            requestedVersion: p.version,
            desiredState: {
              manager: "Asdf",
              tool: p.tool,
              version: p.version,
              scope,
              installed: true,
              active: p.active ?? true,
            },
            observe: (exec) => backends.asdf.observe(identity, scope, exec),
            install: (exec) => backends.asdf.install(identity, exec),
            activate: (exec) => backends.asdf.activate(identity, scope, exec),
            toObservedState: (version, observation) => ({
              manager: "Asdf",
              tool: p.tool,
              version,
              scope,
              installed: observation.installed.includes(version),
              active: observation.active === version,
            }),
            sameIdentity: (state) => state.manager === "Asdf" && state.tool === p.tool,
          };
        },
        Rustup: (p): ToolPlan => {
          const scope = resolveScope(p);
          const identity: RustupToolIdentity = { channel: p.channel };
          return {
            requestedVersion: p.channel,
            desiredState: {
              manager: "Rustup",
              version: p.channel,
              scope,
              installed: true,
              active: p.active ?? true,
            },
            observe: (exec) => backends.rustup.observe(identity, scope, exec),
            install: (exec) => backends.rustup.install(identity, exec),
            activate: (exec) => backends.rustup.activate(identity, scope, exec),
            toObservedState: (version, observation) => ({
              manager: "Rustup",
              version,
              scope,
              installed: observation.installed.includes(version),
              active: observation.active === version,
            }),
            sameIdentity: (state) => state.manager === "Rustup",
          };
        },
        Uv: (p): ToolPlan => {
          const scope = resolveScope(p);
          const identity: UvToolIdentity = { version: p.version };
          return {
            requestedVersion: p.version,
            desiredState: {
              manager: "Uv",
              version: p.version,
              scope,
              installed: true,
              active: p.active ?? true,
            },
            observe: (exec) => backends.uv.observe(identity, scope, exec),
            install: (exec) => backends.uv.install(identity, exec),
            activate: (exec) => backends.uv.activate(identity, scope, exec),
            toObservedState: (version, observation) => ({
              manager: "Uv",
              version,
              scope,
              installed: observation.installed.includes(version),
              active: observation.active === version,
            }),
            sameIdentity: (state) => state.manager === "Uv",
          };
        },
      }),
    );

  const observeState = (
    props: RuntimeToolProps,
    exec: Exec,
  ): Effect.Effect<RuntimeToolState | undefined, BackendError> =>
    Effect.gen(function* () {
      const plan = planFor(props);
      const observation = yield* plan.observe(exec);
      const version = resolveVersion(plan.requestedVersion, observation);
      return version === undefined ? undefined : plan.toObservedState(version, observation);
    });

  const observe = (
    props: RuntimeToolProps,
    ctx: ObserveContext,
  ): Effect.Effect<RuntimeToolState | undefined, BackendError> => observeState(props, ctx.exec);

  return {
    address: (props) =>
      Match.value(props).pipe(
        Match.tagsExhaustive({
          Mise: (p) => backends.mise.configPath(resolveScope(p)),
          Asdf: (p) => backends.asdf.configPath(resolveScope(p)),
          Rustup: (p) => backends.rustup.configPath(resolveScope(p)),
          Uv: (p) => backends.uv.configPath(resolveScope(p)),
        }),
      ),

    observe,

    desired: (props) => Effect.succeed(planFor(props).desiredState),

    // Not equality: `version` is compared with `versionSatisfies`, not `===`,
    // because `desired.version` can still be the recipe's fuzzy request while
    // `observed.version` is always a concrete, resolved one. `active` is the
    // one genuinely optional constraint — a recipe with `active: false` is
    // satisfied by any installed version regardless of what else is active,
    // the same "unconstrained field" shape `Machine.File`'s `mode` uses.
    // `tool` is `undefined` on both sides for `Rustup`/`Uv`, so `===` is
    // still the right comparison there too — nothing case-specific is needed
    // since `RuntimeToolState` is one flat shape, not a union (see its doc
    // comment for why).
    matches: (observed, desired) =>
      observed.manager === desired.manager &&
      observed.tool === desired.tool &&
      scopeEquals(observed.scope, desired.scope) &&
      versionSatisfies(desired.version, observed.version) &&
      observed.installed &&
      (desired.active ? observed.active : true),

    apply: ({ props, observed, desired }, ctx: ApplyContext) =>
      Effect.gen(function* () {
        const plan = planFor(props);

        const alreadyInstalled =
          observed !== undefined &&
          observed.installed &&
          plan.sameIdentity(observed) &&
          versionSatisfies(plan.requestedVersion, observed.version);

        if (!alreadyInstalled) {
          yield* plan.install(ctx.exec);
        }
        if (desired.active) {
          yield* plan.activate(ctx.exec);
        }

        // Re-observed rather than assembled from the calls above, the same
        // way `Machine.File.apply` re-`stat`s instead of trusting its own
        // write: a fuzzy request can resolve to a slightly different
        // concrete version than a naive echo of `props.version` would claim.
        const reobserved = yield* observe(props, ctx);
        if (reobserved === undefined) {
          return yield* Effect.fail(new RuntimeNotConverged({ props }));
        }
        return reobserved;
      }),
  };
});

export const RuntimeToolProvider = () => toProvider(RuntimeTool, makeRuntimeToolReconciler);
