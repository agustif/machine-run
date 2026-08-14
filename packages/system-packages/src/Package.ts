import {
  type ApplyContext,
  type ObserveContext,
  type Reconciler,
  toProvider,
} from "@machine-run/engine";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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
import type { BackendError, PackageManagerBackend } from "./Backend.ts";
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
});

export type PackageProps = typeof PackageProps.Type;

export const PackageState = Schema.Struct({
  manager: PackageManagerId,
  name: Schema.String,
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

/**
 * The provider body, exported separately from `PackageProvider` so a test
 * can build it directly and drive `observe`/`matches`/`apply` without the
 * alchemy engine or a real `CommandExecutor` (see `packages/dotfiles/src/File.ts`
 * for the same pattern).
 */
export const makePackageReconciler: Effect.Effect<
  Reconciler<PackageProps, PackageState, BackendError>
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

  const observe = (props: PackageProps, ctx: ObserveContext) =>
    Effect.gen(function* () {
      const backend = backends[props.manager];
      const index = isApplyPhase(ctx) ? applyIndex : planIndex;
      const installed = yield* index.packages.get(props.manager, () => backend.list(ctx.exec));
      if (!installed.includes(props.name)) return Option.none();
      return Option.some({ manager: props.manager, name: props.name });
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

    desired: (props) => Effect.succeed({ manager: props.manager, name: props.name }),

    // State fully captures what a package declares (no optional/partial
    // fields the way a file's mode can be unset), so plain equality is
    // sufficient — unlike `File`'s `matches`, there is nothing to treat as
    // "unconstrained".
    matches: (observed, desired) =>
      observed.manager === desired.manager && observed.name === desired.name,

    apply: ({ props, desired }, ctx) =>
      Effect.gen(function* () {
        const backend = backends[props.manager];
        yield* backend.install(props.name, ctx.exec);
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
