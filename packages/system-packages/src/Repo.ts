import {
  type ApplyContext,
  type Drift,
  type DriftField,
  executionOf,
  type ObserveContext,
  type Reconciler,
  toProvider,
} from "@machine-run/engine";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { makeAptRepoBackend } from "./backends/linux/Apt.ts";
import { makeDnfRepoBackend } from "./backends/linux/Dnf.ts";
import { makeFlatpakRepoBackend } from "./backends/linux/Flatpak.ts";
import { makeBrewRepoBackend } from "./backends/macos/Brew.ts";
import { type BackendError, RepoSpec } from "./Backend.ts";
import { makePackageIndex } from "./PackageIndex.ts";

/**
 * Managers with a real, server-side "extra repo" concept: a brew tap, an
 * apt PPA, a dnf COPR project, a Flatpak remote. Each is something the
 * manager itself tracks as configuration (a tapped repo, a `sources.list`
 * entry, a `/etc/yum.repos.d/*.repo` file, a registered remote) independent
 * of any package installed from it. `RepoSpec` (`Backend.ts`) names each
 * one's own fields — see its doc comment for what each tag means and why it
 * replaced a flat `{ manager, repo: string }` shape.
 *
 * `repo` is nested one level, `RuntimeScope`'s own pattern in
 * `runtimes/src/Backend.ts` (embedded as `RuntimeToolProps.scope`, never as a
 * resource's entire `Props`): Alchemy's `Resource<Type, Props, Attributes>`
 * needs `Props`/`Attributes` to be a single object type with statically
 * known members to build its output-attribute and input-props machinery
 * (`{ [attr in keyof Attributes]: ... }` and `PropsInput`), and a bare
 * `RepoSpec` at the top level — a union across four disjoint tags — isn't
 * one; nesting it under `repo` gives the resource itself one concrete
 * `Schema.Struct` shape while keeping `RepoSpec` the tagged union that
 * actually rules out mismatched manager/field combinations.
 *
 * `pacman` has no tag in `RepoSpec`. The AUR — the only "extra repo" pacman
 * users reach for — has no equivalent: an AUR helper (`yay`/`paru`, see
 * `backends/linux/Aur.ts`) clones a PKGBUILD and runs `makepkg` locally,
 * then hands pacman an ordinary local package to install. Nothing gets
 * written to `/etc/pacman.conf` or any pacman-tracked repo list, so there is
 * nothing for `listRepos` to observe or `addRepo` to create — nothing to
 * reconcile as a distinct resource. Wanting an AUR-sourced package is
 * expressed as a `System.Package` on manager `"yay"`/`"paru"` directly;
 * there is no separate "enable the AUR" step the way there is for a COPR
 * project or a PPA.
 */
export const RepoProps = Schema.Struct({ repo: RepoSpec });
export type RepoProps = typeof RepoProps.Type;

export const RepoState = Schema.Struct({ repo: RepoSpec });
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
 * Structural equality over `RepoSpec` — the same value for two purposes:
 * "is this spec already in a live listing" (`observe`) and "does an observed
 * state already satisfy a desired one" (`matches`). Both questions are the
 * same question here because `observe` only ever returns either
 * `Option.none()` or `Option.some` of an exact echo of `props` (see its doc
 * comment below), so there is nothing a bespoke `matches` could compare that
 * this doesn't already.
 *
 * `Match.tagsExhaustive` over the tag, rather than a generic per-field walk,
 * means a fifth `RepoSpec` member with a differently-shaped payload is a
 * compile error here, not a silently-wrong `false`.
 */
const repoEquals = (a: RepoSpec, b: RepoSpec): boolean =>
  Match.value(a).pipe(
    Match.tagsExhaustive({
      Brew: (x) => b._tag === "Brew" && b.tap === x.tap,
      Apt: (x) => b._tag === "Apt" && b.ppa === x.ppa,
      Dnf: (x) => b._tag === "Dnf" && b.project === x.project,
      // Name only, deliberately. `remote-add` is given a `.flatpakrepo`
      // *descriptor* URL, and `flatpak remotes` reports the *resolved* repo URL
      // it points at — measured: adding
      // `https://dl.flathub.org/repo/flathub.flatpakrepo` makes `remotes` print
      // `https://dl.flathub.org/repo/`. Comparing those two is comparing
      // different things, and it never matched, so this resource could never
      // converge for a remote added the normal documented way. `remote-add
      // --if-not-exists` is itself keyed on the name, so matching on name is
      // also what `apply` actually does.
      //
      // The honest cost: a remote whose URL was repointed under the same name is
      // not detected as drift. Detecting it would mean resolving the descriptor
      // ourselves — a network fetch inside `observe`, which planning must not do.
      Flatpak: (x) => b._tag === "Flatpak" && b.name === x.name,
    }),
  );

/**
 * Same "which observe call is this" distinction as `Package.ts` — see its
 * doc comment.
 */
const isApplyPhase = (ctx: ObserveContext): ctx is ApplyContext => "snapshot" in ctx;

/**
 * A repository command exited successfully, but a fresh manager listing still
 * cannot find the requested repo. Recording `desired` in that case would make
 * the state file claim a repo exists when the next plan immediately disproves
 * it.
 */
export class RepoNotConverged extends Data.TaggedError("RepoNotConverged")<{
  props: RepoProps;
}> {
  override get message() {
    return `Repository (${this.props.repo._tag}) was reported added, but a fresh manager listing does not contain it.`;
  }
}

/**
 * The provider body, exported separately from `RepoProvider` — same
 * rationale as `makePackageReconciler` in `Package.ts`.
 */
export const makeRepoReconciler: Effect.Effect<
  Reconciler<RepoProps, RepoState, BackendError | RepoNotConverged>
> = Effect.gen(function* () {
  const brew = makeBrewRepoBackend();
  const apt = makeAptRepoBackend();
  const dnf = makeDnfRepoBackend();
  const flatpak = makeFlatpakRepoBackend();

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
      const index = isApplyPhase(ctx) ? applyIndex : planIndex;
      const existing = yield* index.repos.get(props.repo._tag, () =>
        Match.value(props.repo).pipe(
          Match.tagsExhaustive({
            Brew: () => brew.listRepos(ctx.exec),
            Apt: () => apt.listRepos(ctx.exec),
            Dnf: () => dnf.listRepos(ctx.exec),
            Flatpak: () => flatpak.listRepos(ctx.exec),
          }),
        ),
      );
      if (!existing.some((entry) => repoEquals(entry, props.repo))) return Option.none();
      // Every field this resource tracks about a repo lives in `props`
      // itself — unlike `Ai.McpServer`'s state, there is nothing an
      // observation resolves that props didn't already say, so the state
      // this returns is exactly the spec that was found.
      return Option.some(props);
    });

  return {
    // Same reasoning as `Package.ts`: `brew tap`/`add-apt-repository` touch
    // the same per-manager global state (and, for apt, the same dpkg lock)
    // that installing a package does, so a repo add serialises with every
    // other `System.Repo`/`System.Package` on that manager rather than
    // racing them. The tag is a stable, distinct-per-manager string by
    // construction — no separate manager id is needed to build this.
    address: (props) => props.repo._tag,

    /**
     * Every extra repository each manager on this machine reports.
     *
     * Enumerates across all four rather than one: a machine can carry both a
     * Homebrew tap and an apt PPA, and covering one would be an incomplete
     * inventory presented as complete. Availability is not probed here the way
     * `System.Package.list` probes it — a manager that is absent fails its
     * `listRepos` and that failure propagates, because unlike a package listing
     * there is no useful "this manager has no repos" answer to distinguish from
     * "this manager is not installed". A short inventory is worse than none.
     */
    list: (ctx) => {
      // Annotated to the union: each backend's `listRepos` returns its own arm
      // of `RepoSpec`, and an unannotated array literal infers from whichever
      // element comes first, making the other three type errors.
      const listers: ReadonlyArray<() => Effect.Effect<readonly RepoSpec[], BackendError>> = [
        () => brew.listRepos(ctx.exec),
        () => apt.listRepos(ctx.exec),
        () => dnf.listRepos(ctx.exec),
        () => flatpak.listRepos(ctx.exec),
      ];
      return Effect.forEach(listers, (listRepos) => listRepos(), {
        concurrency: 4,
      }).pipe(Effect.map((perManager) => perManager.flat().map((repo) => ({ repo }))));
    },

    observe,

    desired: (props) => Effect.succeed(props),

    matches: (observed, desired) => repoEquals(observed.repo, desired.repo),

    // Must agree with `matches`: empty exactly when it returns true. Every
    // `RepoSpec` tag names a different field (`tap`/`ppa`/`project`/
    // `name`+`location`), none ordered, so `direction` never applies here.
    drift: (observed, desired): Drift => {
      const o = observed.repo;
      const d = desired.repo;
      if (repoEquals(o, d)) return [];
      return Match.value(d).pipe(
        Match.tagsExhaustive({
          Brew: (spec) => [
            { field: "tap", observed: o._tag === "Brew" ? o.tap : "", desired: spec.tap },
          ],
          Apt: (spec) => [
            { field: "ppa", observed: o._tag === "Apt" ? o.ppa : "", desired: spec.ppa },
          ],
          Dnf: (spec) => [
            {
              field: "project",
              observed: o._tag === "Dnf" ? o.project : "",
              desired: spec.project,
            },
          ],
          Flatpak: (spec) => {
            const fields: DriftField[] = [];
            if (!(o._tag === "Flatpak" && o.name === spec.name)) {
              fields.push({
                field: "name",
                observed: o._tag === "Flatpak" ? o.name : "",
                desired: spec.name,
              });
            }
            // No `location` field, deliberately: `matches` above compares
            // Flatpak remotes on `name` alone (see `repoEquals`), and `drift`
            // must be empty exactly when `matches` is true. Reporting a
            // location difference here would claim drift the plan then says
            // nothing about, and that `apply` could not fix in any case.
            return fields;
          },
        }),
      );
    },

    apply: ({ props }, ctx) =>
      Effect.gen(function* () {
        const execution = executionOf(ctx);
        yield* Match.value(props.repo).pipe(
          Match.tagsExhaustive({
            Brew: (p) => brew.addRepo(p, ctx.exec, execution),
            Apt: (p) => apt.addRepo(p, ctx.exec, execution),
            Dnf: (p) => dnf.addRepo(p, ctx.exec, execution),
            Flatpak: (p) => flatpak.addRepo(p, ctx.exec, execution),
          }),
        );
        // Same reasoning as `Package.ts`: the cached repo listing for this
        // manager is now stale, so the next `System.Repo` resource on the
        // same manager must not see the pre-add snapshot.
        yield* applyIndex.repos.invalidate(props.repo._tag);

        // As with package installation, the command's exit code is not a
        // read-after-write guarantee. Confirm through the same listing path
        // planning uses before recording a successful state.
        const confirmed = yield* observe(props, ctx);
        if (Option.isNone(confirmed)) {
          return yield* Effect.fail(new RepoNotConverged({ props }));
        }
        return confirmed.value;
      }),
  };
});

export const RepoProvider = () => toProvider(Repo, makeRepoReconciler);
