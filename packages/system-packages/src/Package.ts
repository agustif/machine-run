import { compareVersions, UpdatePolicy, VersionSpec } from "@machine-run/core";
import {
  type ApplyContext,
  type ObserveContext,
  type Reconciler,
  toProvider,
} from "@machine-run/engine";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as UndefinedOr from "effect/UndefinedOr";
import { makeYayBackend, makeParuBackend } from "./backends/linux/Aur.ts";
import { makeAptBackend } from "./backends/linux/Apt.ts";
import { makeFlatpakBackend } from "./backends/linux/Flatpak.ts";
import { makeSnapBackend } from "./backends/linux/Snap.ts";
import { makeBrewBackend, makeBrewCaskBackend } from "./backends/macos/Brew.ts";
import { makeGoBackend } from "./backends/language/Go.ts";
import { makeCargoBackend } from "./backends/language/Cargo.ts";
import { makeGemBackend } from "./backends/language/Gem.ts";
import { makeChocoBackend } from "./backends/windows/Choco.ts";
import { makeDnfBackend } from "./backends/linux/Dnf.ts";
import { makeMasBackend } from "./backends/macos/Mas.ts";
import { makePortBackend } from "./backends/macos/MacPorts.ts";
import { makeNpmBackend } from "./backends/language/Npm.ts";
import { makePacmanBackend } from "./backends/linux/Pacman.ts";
import { makePipxBackend } from "./backends/language/Pipx.ts";
import { makeUvToolBackend } from "./backends/language/UvTool.ts";
import { makeWingetBackend } from "./backends/windows/Winget.ts";
import {
  CannotDowngrade,
  type BackendError,
  type PackageManagerBackend,
  UnsupportedVersionSpec,
} from "./Backend.ts";
import { makePackageIndex } from "./PackageIndex.ts";

export const PackageManagerId = Schema.Literals([
  "brew",
  "brew-cask",
  "port",
  "apt",
  "dnf",
  "pacman",
  "cargo",
  "npm",
  "winget",
  "choco",
  "pipx",
  "uv-tool",
  "gem",
  "go-install",
  "mas",
  "flatpak",
  "snap",
  "yay",
  "paru",
]);

export type PackageManagerId = typeof PackageManagerId.Type;

export const PackageProps = Schema.Struct({
  manager: PackageManagerId,
  /** The package's name in that manager's own namespace, e.g. "mise", "cargo-bloat", "@opencode-ai/cli". */
  name: Schema.String,
  /**
   * What version to install, in `@machine-run/core`'s shared `VersionSpec`
   * vocabulary — absent means "whatever the manager resolves as current",
   * the only behaviour this resource had before this field existed.
   *
   * Not every manager accepts every `VersionSpec` tag, and that acceptance
   * is declared **in each backend's own type**
   * (`Backend.ts`'s `PackageVersionSupport`), not assumed here: naming a
   * `version` this manager cannot honour fails loudly with
   * `UnsupportedVersionSpec` rather than being silently installed unpinned.
   * `snap` accepts only `Channel` (a track, never a semver); `mas` accepts
   * nothing at all (`mas install` takes only an App Store id); pacman's
   * official repos hold exactly one build per package, so `Exact` only ever
   * succeeds when it names the version already current — see each backend's
   * own doc comment for what was actually run to confirm this, not assumed
   * from documentation.
   *
   * This resource does not use `VersionSpec.AtLeast`'s dotted-prefix
   * semantics for comparison — see `matches`'s own doc comment below for
   * why plain equality is what's actually implemented, and where that stops
   * being an academic distinction.
   */
  version: Schema.optionalKey(VersionSpec),
  /**
   * What to do when `version` and the live version disagree, from
   * `@machine-run/core`'s `UpdatePolicy` — defaults to `Never` (install once
   * if absent, then leave version drift alone forever) when unset, which is
   * `System.Package`'s original, undocumented, only behaviour, restated
   * here as an explicit, statable choice rather than an accident. See this
   * module's `resolvePolicy` and `matches` for exactly what each case does.
   */
  updatePolicy: Schema.optionalKey(UpdatePolicy),
});

export type PackageProps = typeof PackageProps.Type;

export const PackageState = Schema.Struct({
  manager: PackageManagerId,
  name: Schema.String,
  /**
   * The concrete version/channel string a backend's own listing reported,
   * when it can report one at all (see `Backend.ts`'s `PackageEntry`) — on
   * `desired`, the string `props.version`/`props.updatePolicy` actually
   * constrain observed state to, or absent when nothing does (see
   * `resolvedTarget`). Absence on either side is the "unconstrained field"
   * idiom `Machine.File.mode` already uses, not a placeholder.
   */
  version: Schema.optionalKey(Schema.String),
});

export type PackageState = typeof PackageState.Type;

/**
 * One installed package, from one manager. This is the atomic unit
 * everything else composes from — there is deliberately no "bundle" resource
 * that owns a whole list; a role/recipe just declares one `Package` per
 * package it wants, the same way alchemy's own resources are always one
 * cloud object each (never "the AWS.S3.Bucket resource that owns all your
 * buckets").
 */
export interface Package extends Resource<"System.Package", PackageProps, PackageState> {}

export const Package = Resource<Package>("System.Package");

/**
 * Distinguishes an `observe` call made during planning (an `ObserveContext`,
 * the shape `diff`/`read` pass in `toProvider.ts`) from one made from inside
 * `reconcile`, immediately before a possible `apply` (an `ApplyContext`,
 * which extends it with `snapshot`). See {@link makePackageReconciler}'s
 * `planIndex`/`applyIndex` split for why this distinction matters.
 */
const isApplyPhase = (ctx: ObserveContext): ctx is ApplyContext => "snapshot" in ctx;

/** The comparable string one `VersionSpec` tag names — see `PackageState.version`'s doc comment. */
const versionSpecTarget = (spec: VersionSpec): string =>
  Match.value(spec).pipe(
    Match.tagsExhaustive({
      Exact: (s) => s.version,
      AtLeast: (s) => s.version,
      Channel: (s) => s.name,
      Digest: (s) => s.hash,
    }),
  );

/**
 * `props.updatePolicy`'s default — see `PackageProps.updatePolicy`'s doc
 * comment for why `Never` is the one that applies when a recipe says
 * nothing at all.
 */
const resolvePolicy = (props: PackageProps): UpdatePolicy => props.updatePolicy ?? { _tag: "Never" };

/**
 * What `observed.version` must equal for a package to count as converged,
 * given `props`'s policy — `undefined` (the "unconstrained" case `matches`
 * already treats every other absent field as) under `Never` and `Latest`,
 * since neither policy makes version drift this resource's concern once the
 * package is present at all (see `PackageProps.updatePolicy`'s doc comment
 * for why both stop there rather than actively reconciling toward
 * anything), and the pinned target string under `ToSpec`.
 */
const resolvedTarget = (props: PackageProps): string | undefined =>
  Match.value(resolvePolicy(props)).pipe(
    Match.tagsExhaustive({
      Never: () => undefined,
      Latest: () => undefined,
      ToSpec: () => UndefinedOr.map(props.version, versionSpecTarget),
    }),
  );

/**
 * The provider body, exported separately from `PackageProvider` so a test
 * can build it directly and drive `observe`/`matches`/`apply` without the
 * alchemy engine or a real `CommandExecutor` (see `packages/dotfiles/src/File.ts`
 * for the same pattern).
 */
export const makePackageReconciler: Effect.Effect<
  Reconciler<PackageProps, PackageState, BackendError | UnsupportedVersionSpec | CannotDowngrade>
> = Effect.gen(function* () {
  const backends = {
    brew: makeBrewBackend(),
    "brew-cask": makeBrewCaskBackend(),
    port: makePortBackend(),
    apt: makeAptBackend(),
    dnf: makeDnfBackend(),
    pacman: makePacmanBackend(),
    cargo: makeCargoBackend(),
    npm: makeNpmBackend(),
    winget: makeWingetBackend(),
    choco: makeChocoBackend(),
    pipx: makePipxBackend(),
    "uv-tool": makeUvToolBackend(),
    gem: makeGemBackend(),
    "go-install": makeGoBackend(),
    mas: makeMasBackend(),
    flatpak: makeFlatpakBackend(),
    snap: makeSnapBackend(),
    yay: makeYayBackend(),
    paru: makeParuBackend(),
  } satisfies Record<PackageManagerId, PackageManagerBackend>;

  // Two independent memoized `list()` caches — one consulted only while
  // planning (`diff`/`read`, via `ObserveContext`), one only from inside
  // `reconcile`'s pre-apply re-observe (via `ApplyContext`) — NOT one shared
  // instance. `toProvider` calls `observe` from both places: once up front to
  // build the whole plan, and again, per resource, immediately before
  // deciding whether to `apply`. If both calls drew from the same cache, a
  // package uninstalled by something else *between* those two moments (a
  // human reviewing a plan before confirming it, an interactive `alchemy
  // plan` followed by a separate `apply`) would still read as present: the
  // plan-time `observe` populated the cache while the package still existed,
  // and the apply-time `observe` would then reuse that stale entry instead of
  // re-listing, so the very drift this caching exists alongside would
  // silently survive an entire apply. Two independent instances mean the
  // worst case is one extra real listing per manager per phase — still far
  // better than one per resource — while keeping the apply-time view of
  // "what's installed" honestly independent of whatever planning saw
  // earlier. See PackageIndex.ts for the mechanics of `MemoizedLister` itself.
  const planIndex = yield* makePackageIndex;
  const applyIndex = yield* makePackageIndex;

  /**
   * Fails with {@link UnsupportedVersionSpec} when `props.version` is set to
   * a tag this manager's backend doesn't accept — checked once, here, so
   * both `desired` (surfacing the failure during planning, not only at
   * apply) and `apply` share the identical decision rather than each
   * re-deriving it.
   */
  const checkVersionSupported = (
    props: PackageProps,
  ): Effect.Effect<void, UnsupportedVersionSpec> => {
    const backend = backends[props.manager];
    if (props.version === undefined) return Effect.void;
    if (backend.versions.accepts.has(props.version._tag)) return Effect.void;
    return Effect.fail(
      new UnsupportedVersionSpec({
        manager: props.manager,
        spec: props.version,
        accepts: backend.versions.accepts,
      }),
    );
  };

  const observe = (props: PackageProps, ctx: ObserveContext) =>
    Effect.gen(function* () {
      const backend = backends[props.manager];
      const index = isApplyPhase(ctx) ? applyIndex : planIndex;
      const installed = yield* index.packages.get(props.manager, () => backend.list(ctx.exec));
      // `Arr.findFirst` rather than `.find` plus an `=== undefined` check: the
      // absence this is looking for is exactly what `Option` models, and the
      // version work made the entry itself carry a `version` worth keeping.
      return Arr.findFirst(installed, (candidate) => candidate.name === props.name).pipe(
        Option.map((entry) => ({
          manager: props.manager,
          name: props.name,
          version: entry.version,
        })),
      );
    });

  return {
    // Serialises on the *manager*, not on `manager:name`. apt/dpkg holds a
    // single global lock (`/var/lib/dpkg/lock-frontend`), so two concurrent
    // `apt-get install` invocations fail outright rather than queueing;
    // Homebrew is similarly unhappy with concurrent installs. Alchemy
    // reconciles independent resources with `concurrency: "unbounded"`, so a
    // recipe declaring 30 packages on one manager would otherwise fire 30
    // concurrent installs. Using the manager id as the address makes the
    // engine's own address-based locking (see `Reconciler.address`'s doc
    // comment) serialise every package on one manager through one queue,
    // while packages on *different* managers (brew vs. cargo, say) still
    // reconcile in parallel. The tradeoff: installs on the same manager never
    // overlap, even when the underlying tool could safely have handled two at
    // once — correctness over throughput, for a lock that is cheap to hold
    // (a `brew install` taking longer only serialises other brew installs,
    // never anything else).
    address: (props) => props.manager,

    observe,

    desired: (props) =>
      Effect.gen(function* () {
        yield* checkVersionSupported(props);
        return { manager: props.manager, name: props.name, version: resolvedTarget(props) };
      }),

    // State fully captures what a package declares, with one exception:
    // `version` is deliberately *not* plain equality between `observed` and
    // `desired` the way `manager`/`name` are. `desired.version` is already
    // `undefined` unless `updatePolicy` is `ToSpec` (see `resolvedTarget`),
    // so this is the same "unconstrained field" idiom `Machine.File.mode`
    // uses for a prop that doesn't always constrain anything — not a weaker
    // form of equality, a *narrower* one that only applies when the recipe
    // actually asked for it.
    //
    // This does mean a `ToSpec`-pinned `AtLeast` request is compared by
    // plain string equality here, not `core`'s `matchesVersionSpec` prefix
    // rule — a stated simplification, not an oversight: no backend below
    // declares `AtLeast` in its `PackageVersionSupport.accepts` (none of the
    // 19 managers this package wraps resolve a version *range* the way
    // `mise`/`asdf` do for `Runtime.Tool`), so `checkVersionSupported` above
    // already rejects an `AtLeast` spec for every manager before `matches`
    // would ever see one — this branch is unreachable today, not silently
    // wrong.
    matches: (observed, desired) =>
      observed.manager === desired.manager &&
      observed.name === desired.name &&
      (desired.version === undefined || observed.version === desired.version),

    apply: ({ props, observed, desired }, ctx) =>
      Effect.gen(function* () {
        const backend = backends[props.manager];

        // `apply` only ever runs when `matches` returned false, which for an
        // *already-present* package only happens under `ToSpec` (see
        // `matches`'s doc comment) — so `observed !== undefined` here means
        // "converging an existing install to a new pin", not "installing
        // fresh". `compareVersions` (from `core`) tells forward from
        // backward: closing an `"Ahead"` gap needs a downgrade, which this
        // manager may not support at all (`PackageVersionSupport.canDowngrade`).
        // Failing here, before ever invoking the backend, is the difference
        // between a clear, typed `CannotDowngrade` and whatever confusing
        // text the underlying CLI happens to print for the same refusal.
        //
        // `"Unknown"` is refused too, but *only* for a fixed-target pin
        // (`Exact`/`AtLeast`) — never for `Channel`/`Digest`. pacman's own
        // version strings (`2.3.2-1`, a `pkgver-pkgrel` pair, now handled by
        // `compareVersions`'s `.`/`-` split) and an AUR VCS package's
        // (`r1234.deadbeef`, still `"Unknown"` — no numeric grammar covers a
        // commit hash) are the real cases this guards: for a manager that
        // cannot recover from a wrong guess (`canDowngrade: false`), refusing
        // to move at all when direction genuinely can't be told is the rule
        // 11 reading — we cannot prove it *isn't* backward. A `Channel` pin
        // (flatpak's branch, snap's track) is a different question entirely:
        // switching channels is never a downgrade question, `compareVersions`
        // correctly calls a channel-name pair `"Unknown"` because channel
        // names have no order, and refusing every channel switch on
        // `canDowngrade: false` (flatpak's own value) would make every
        // legitimate branch change fail — so this only ever applies to a
        // spec that names an actual version.
        // Exhaustive over `VersionSpec` rather than
        // `_tag === "Exact" || _tag === "AtLeast"`: a fifth case added to the
        // union later must be a compile error here, not silently classified
        // as "not a version" and quietly excluded from the guard above.
        const pinNamesAVersion = UndefinedOr.match(props.version, {
          onUndefined: () => false,
          onDefined: (spec) =>
            Match.value(spec).pipe(
              Match.tagsExhaustive({
                Exact: () => true,
                AtLeast: () => true,
                Channel: () => false,
                Digest: () => false,
              }),
            ),
        });
        // `observed` is an `Option` since the seam migration, so the guard reads
        // as one flatMap rather than three `!== undefined` checks: a live version
        // is needed, a pinned version is needed, and the pin has to name a
        // version at all.
        const liveVersion = Option.flatMap(observed, (state) =>
          UndefinedOr.match(state.version, {
            onUndefined: () => Option.none<string>(),
            onDefined: (version) => Option.some(version),
          }),
        );
        if (Option.isSome(liveVersion) && desired.version !== undefined && pinNamesAVersion) {
          const installed = liveVersion.value;
          const drift = compareVersions(installed, desired.version);
          if ((drift === "Ahead" || drift === "Unknown") && !backend.versions.canDowngrade) {
            return yield* Effect.fail(
              new CannotDowngrade({
                manager: props.manager,
                name: props.name,
                installed,
                desired: desired.version,
                direction: drift,
              }),
            );
          }
        }

        // Real, not hypothetical (see `PackageManagerBackend.refreshIndex`'s
        // doc comment): a stale local index makes the install below fail for
        // any package whose requested version — or, for some managers, any
        // package at all — isn't in the last-synced snapshot.
        if (backend.refreshIndex !== undefined) {
          yield* backend.refreshIndex(ctx.exec);
        }

        yield* backend.install(props.name, props.version, ctx.exec);
        // The cached listing for this manager no longer reflects reality —
        // it was taken (by this call's own re-observe, or an earlier apply
        // for a sibling `System.Package` on the same manager) *before* this
        // install. Without invalidating, the next distinct package sharing
        // this manager would check membership against that stale snapshot:
        // harmless for a still-missing package (it would just install too,
        // correctly), but wrong for anything expecting the listing to
        // already include what was *just* installed. Dropping the entry
        // rather than optimistically appending `props.name` to it keeps this
        // correct even though a manager's listing command sometimes reports
        // slightly different name forms (e.g. brew's list vs. its casks)
        // than what a caller passed as `name`.
        yield* applyIndex.packages.invalidate(props.manager);
        return desired;
      }),
  };
});

export const PackageProvider = () => toProvider(Package, makePackageReconciler);
