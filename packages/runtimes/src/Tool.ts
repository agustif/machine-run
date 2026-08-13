import { MachinePaths } from "@machine-run/core";
import { type ObserveContext, type Reconciler, toProvider } from "@machine-run/engine";
import { Resource } from "alchemy/Resource";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { makeAsdfBackend } from "./backends/Asdf.ts";
import { makeMiseBackend } from "./backends/Mise.ts";
import { makeRustupBackend } from "./backends/Rustup.ts";
import { makeUvBackend } from "./backends/Uv.ts";
import {
  type BackendError,
  type RuntimeBackend,
  RuntimeManagerId,
  RuntimeScope,
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
 * ## Versions are requests, not names
 *
 * `tool` is looked up by membership, the same way `System.Package.name` is —
 * whatever string the backend's own namespace uses (`"node"` for mise,
 * `"nodejs"` for asdf; there is deliberately no cross-manager name mapping,
 * for the same reason `PackageManagerBackend` has none). `version` is
 * different: it is a request, not a name, and `matches` resolves it with
 * {@link versionSatisfies} — a dotted-prefix rule, not equality — because
 * every backend already resolves the identical shorthand itself (`mise use
 * node@22`, `asdf install nodejs 22`, `uv python pin 3.12`). See
 * `version.ts` for the exact rule and why it stops short of full semver
 * ranges.
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
export const RuntimeToolProps = Schema.Struct({
  manager: RuntimeManagerId,
  /** The tool's name in that manager's own namespace, e.g. `"node"` (mise), `"nodejs"` (asdf). Ignored by rustup/uv, which each manage exactly one fixed tool — see {@link RuntimeToolMismatch}. */
  tool: Schema.String,
  /** A version request: `"22"`, `"22.11"`, `"22.11.0"`, or a rustup channel like `"stable"`. See {@link versionSatisfies}. */
  version: Schema.String,
  /** Where this is activated. Defaults to {@link RuntimeScope}'s `Global` case. */
  scope: Schema.optionalKey(RuntimeScope),
  /** Whether this version must also be the *active* one at `scope`, versus merely installed. Defaults to `true`. */
  active: Schema.optionalKey(Schema.Boolean),
});
export type RuntimeToolProps = typeof RuntimeToolProps.Type;

/**
 * `version` is always the concrete, resolved version a backend reported —
 * never the fuzzy request `props.version` may have been. `installed` and
 * `active` are kept apart rather than folded into one boolean; see this
 * module's doc comment for why both independently matter.
 */
export const RuntimeToolState = Schema.Struct({
  manager: RuntimeManagerId,
  tool: Schema.String,
  scope: RuntimeScope,
  version: Schema.String,
  installed: Schema.Boolean,
  active: Schema.Boolean,
});
export type RuntimeToolState = typeof RuntimeToolState.Type;

export interface RuntimeTool extends Resource<"Runtime.Tool", RuntimeToolProps, RuntimeToolState> {}

export const RuntimeTool = Resource<RuntimeTool>("Runtime.Tool");

/**
 * Raised when `props.tool` names anything other than what a single-tool
 * manager fixes it to — rustup only ever manages `"rust"`, uv only ever
 * manages `"python"`. Caught here, generically, off {@link
 * RuntimeBackend.fixedTool}, rather than each backend rejecting its own
 * mismatch — see rule 3 in `AGENTS.md`: no special case for a specific
 * backend inside the generic resource.
 */
export class RuntimeToolMismatch extends Data.TaggedError("RuntimeToolMismatch")<{
  manager: RuntimeManagerId;
  tool: string;
  expected: string;
}> {
  override get message() {
    return `"${this.manager}" only manages "${this.expected}", not "${this.tool}". Set \`tool: "${this.expected}"\`, or pick a different manager for this tool.`;
  }
}

/**
 * Raised when `install` and (if requested) `activate` both ran without error,
 * yet a fresh observation still finds nothing satisfying the request. This
 * should not happen against a well-behaved backend — it means the manager
 * reported success while leaving the machine in a state its own listing
 * command doesn't recognize — and is surfaced rather than silently retried or
 * guessed past, per rule 11 in `AGENTS.md`.
 */
export class RuntimeNotConverged extends Data.TaggedError("RuntimeNotConverged")<{
  manager: RuntimeManagerId;
  tool: string;
  version: string;
}> {
  override get message() {
    return `${this.manager} reported "${this.tool}@${this.version}" installed, but a fresh observation still can't find a version satisfying that request. The manager's own listing command disagrees with its install/activate commands.`;
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

export const makeRuntimeToolReconciler: Effect.Effect<
  Reconciler<
    RuntimeToolProps,
    RuntimeToolState,
    BackendError | RuntimeToolMismatch | RuntimeNotConverged
  >,
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
  } satisfies Record<RuntimeManagerId, RuntimeBackend>;

  const checkTool = (manager: RuntimeManagerId, tool: string) => {
    const expected = backends[manager].fixedTool;
    return expected !== undefined && expected !== tool
      ? Effect.fail(new RuntimeToolMismatch({ manager, tool, expected }))
      : Effect.void;
  };

  const observe = (props: RuntimeToolProps, ctx: ObserveContext) =>
    Effect.gen(function* () {
      yield* checkTool(props.manager, props.tool);
      const backend = backends[props.manager];
      const scope = resolveScope(props);
      const observation = yield* backend.observe(props.tool, scope, ctx.exec);

      const activeSatisfies =
        observation.active !== undefined && versionSatisfies(props.version, observation.active);
      const matchingInstalled = observation.installed.find((candidate) =>
        versionSatisfies(props.version, candidate),
      );

      // Neither the active version nor anything installed satisfies the
      // request: there is genuinely nothing here yet.
      if (!activeSatisfies && matchingInstalled === undefined) return undefined;

      // The active version wins over a merely-installed one when both would
      // do — reporting a different (older or newer) installed version here
      // would make `matches` reject an already-satisfied request and force a
      // pointless reactivation.
      const version = activeSatisfies
        ? (observation.active as string)
        : (matchingInstalled as string);

      return {
        manager: props.manager,
        tool: props.tool,
        scope,
        version,
        installed: observation.installed.includes(version),
        active: observation.active === version,
      };
    });

  return {
    address: (props) => backends[props.manager].configPath(resolveScope(props)),

    observe,

    desired: (props) =>
      Effect.succeed({
        manager: props.manager,
        tool: props.tool,
        scope: resolveScope(props),
        version: props.version,
        installed: true,
        active: props.active ?? true,
      }),

    // Not equality: `version` is compared with `versionSatisfies`, not `===`,
    // because `desired.version` can still be the recipe's fuzzy request while
    // `observed.version` is always a concrete, resolved one. `active` is the
    // one genuinely optional constraint — a recipe with `active: false` is
    // satisfied by any installed version regardless of what else is active,
    // the same "unconstrained field" shape `Machine.File`'s `mode` uses.
    matches: (observed, desired) =>
      observed.manager === desired.manager &&
      observed.tool === desired.tool &&
      scopeEquals(observed.scope, desired.scope) &&
      versionSatisfies(desired.version, observed.version) &&
      observed.installed &&
      (desired.active ? observed.active : true),

    apply: ({ props, observed, desired }, ctx) =>
      Effect.gen(function* () {
        yield* checkTool(props.manager, props.tool);
        const backend = backends[props.manager];

        const alreadyInstalled =
          observed !== undefined &&
          observed.installed &&
          versionSatisfies(props.version, observed.version);

        if (!alreadyInstalled) {
          yield* backend.install(props.tool, props.version, ctx.exec);
        }
        if (desired.active) {
          yield* backend.activate(props.tool, props.version, desired.scope, ctx.exec);
        }

        // Re-observed rather than assembled from the calls above, the same
        // way `Machine.File.apply` re-`stat`s instead of trusting its own
        // write: a fuzzy request can resolve to a slightly different
        // concrete version than a naive echo of `props.version` would claim.
        const reobserved = yield* observe(props, ctx);
        if (reobserved === undefined) {
          return yield* Effect.fail(
            new RuntimeNotConverged({
              manager: props.manager,
              tool: props.tool,
              version: props.version,
            }),
          );
        }
        return reobserved;
      }),
  };
});

export const RuntimeToolProvider = () => toProvider(RuntimeTool, makeRuntimeToolReconciler);
