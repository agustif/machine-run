import {
  type ApplyContext,
  type ObserveContext,
  type Reconciler,
  toProvider,
} from "@machine-run/engine";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeAptBackend } from "./backends/linux/Apt.ts";
import { makeDnfBackend } from "./backends/linux/Dnf.ts";
import { makeBrewBackend } from "./backends/macos/Brew.ts";
import type { BackendError, PackageManagerBackend } from "./Backend.ts";
import { makePackageIndex } from "./PackageIndex.ts";

/**
 * Managers with a real, server-side "extra repo" concept: a brew tap, an
 * apt PPA, a dnf COPR project. Each is something the manager itself tracks
 * as configuration (a tapped repo, a `sources.list` entry, a
 * `/etc/yum.repos.d/*.repo` file) independent of any package installed
 * from it.
 *
 * `pacman` is deliberately not in this list. The AUR — the only "extra
 * repo" pacman users reach for — has no equivalent: an AUR helper
 * (`yay`/`paru`, see `backends/linux/Aur.ts`) clones a PKGBUILD and runs
 * `makepkg` locally, then hands pacman an ordinary local package to
 * install. Nothing gets written to `/etc/pacman.conf` or any pacman-tracked
 * repo list, so there is nothing for `listRepos` to observe or `addRepo` to
 * create — nothing to reconcile as a distinct resource. Wanting an
 * AUR-sourced package is expressed as a `System.Package` on manager
 * `"yay"`/`"paru"` directly; there is no separate "enable the AUR" step the
 * way there is for a COPR project or a PPA.
 */
export const RepoManagerId = Schema.Literals(["brew", "apt", "dnf"]);
export type RepoManagerId = typeof RepoManagerId.Type;

export const RepoProps = Schema.Struct({
  manager: RepoManagerId,
  /** e.g. "can1357/tap" (brew), "ppa:some/ppa" (apt), or "owner/project" (dnf COPR). */
  repo: Schema.String,
});

export type RepoProps = typeof RepoProps.Type;

export const RepoState = Schema.Struct({
  manager: RepoManagerId,
  repo: Schema.String,
});

export type RepoState = typeof RepoState.Type;

/**
 * One extra package repository (a Homebrew tap, an apt PPA) — atomic and
 * separate from {@link Package}, sequenced by ordinary `Effect.gen`
 * ordering (yield the Repo before the Packages that need it) rather than a
 * `dependsOn` field.
 */
export interface Repo extends Resource<"System.Repo", RepoProps, RepoState> {}

export const Repo = Resource<Repo>("System.Repo");

/**
 * Raised when the selected manager's backend implements neither `listRepos`
 * nor `addRepo`.
 *
 * Reporting success for a repository that was never added is strictly worse
 * than failing: a recipe author sees a clean apply and reasonably concludes
 * the tap or PPA is present, then hits a missing-package error somewhere
 * unrelated. Partial support — one of the two methods but not both — is
 * treated the same way, since a repo cannot be reconciled without both. This
 * is raised from `observe` (which needs `listRepos` to answer "is it already
 * there") before `apply` (which needs `addRepo`) is ever reached, so an
 * unsupported manager fails during planning, not partway through an apply.
 */
export class UnsupportedRepoManager extends Data.TaggedError("UnsupportedRepoManager")<{
  manager: string;
}> {
  override get message() {
    return `"${this.manager}" has no repo support (no listRepos/addRepo on its backend), but a System.Repo resource selected it. Pick a manager from RepoManagerId that actually implements both.`;
  }
}

/**
 * Same "which observe call is this" distinction as `Package.ts` — see its
 * doc comment.
 */
const isApplyPhase = (ctx: ObserveContext): ctx is ApplyContext => "snapshot" in ctx;

/**
 * The provider body, exported separately from `RepoProvider` — same
 * rationale as `makePackageReconciler` in `Package.ts`.
 */
export const makeRepoReconciler: Effect.Effect<
  Reconciler<RepoProps, RepoState, BackendError | UnsupportedRepoManager>
> = Effect.gen(function* () {
  const backends = {
    brew: makeBrewBackend(),
    apt: makeAptBackend(),
    dnf: makeDnfBackend(),
  } satisfies Record<RepoManagerId, PackageManagerBackend>;
  // Shared with `Package.ts`'s notion of "one memoized listing per manager
  // per phase" — see PackageIndex.ts and `Package.ts`'s `planIndex`/
  // `applyIndex` doc comment for why a plan-phase and an apply-phase cache
  // must be independent instances. `repos` is a distinct keyspace from
  // `packages` (both live inside the one `PackageIndex` each of these is) so
  // a "brew" *repo* listing (taps) can never satisfy a "brew" *package*
  // listing lookup or vice versa.
  const planIndex = yield* makePackageIndex;
  const applyIndex = yield* makePackageIndex;

  const observe = (props: RepoProps, ctx: ObserveContext) =>
    Effect.gen(function* () {
      const backend = backends[props.manager];
      const { listRepos, addRepo } = backend;
      if (!listRepos || !addRepo) {
        return yield* Effect.fail(new UnsupportedRepoManager({ manager: props.manager }));
      }
      const index = isApplyPhase(ctx) ? applyIndex : planIndex;
      const existing = yield* index.repos.get(props.manager, () => listRepos(ctx.exec));
      if (!existing.includes(props.repo)) return undefined;
      return { manager: props.manager, repo: props.repo };
    });

  return {
    // Same reasoning as `Package.ts`: `brew tap`/`add-apt-repository` touch
    // the same per-manager global state (and, for apt, the same dpkg lock)
    // that installing a package does, so a repo add serialises with every
    // other `System.Repo`/`System.Package` on that manager rather than
    // racing them.
    address: (props) => props.manager,

    observe,

    desired: (props) => Effect.succeed({ manager: props.manager, repo: props.repo }),

    matches: (observed, desired) =>
      observed.manager === desired.manager && observed.repo === desired.repo,

    apply: ({ props, desired }, ctx) =>
      Effect.gen(function* () {
        const backend = backends[props.manager];
        const { addRepo } = backend;
        // `observe` already failed loudly for a manager missing either
        // method, and always runs before `apply` (see `toProvider.ts`'s
        // `reconcile`), so this is unreachable in practice. It stays a typed
        // failure rather than a non-null assertion so that invariant is
        // never silently relied upon.
        if (!addRepo) {
          return yield* Effect.fail(new UnsupportedRepoManager({ manager: props.manager }));
        }
        yield* addRepo(props.repo, ctx.exec);
        // Same reasoning as `Package.ts`: the cached repo listing for this
        // manager is now stale, so the next `System.Repo` resource on the
        // same manager must not see the pre-add snapshot.
        yield* applyIndex.repos.invalidate(props.manager);
        return desired;
      }),
  };
});

export const RepoProvider = () => toProvider(Repo, makeRepoReconciler);
