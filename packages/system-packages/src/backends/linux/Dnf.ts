import { Sh, Timeouts } from "@machine-run/core";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as UndefinedOr from "effect/UndefinedOr";
import {
  type DnfRepo,
  elevated,
  type PackageEntry,
  type PackageManagerBackend,
  type PackageVersionSupport,
  rejectUnsupportedVersionSpec,
  type RepoBackend,
  type PackageTimeouts,
} from "../../Backend.ts";
import { lines } from "../../parse.ts";

/**
 * dnf pins by NEVRA (`name-[epoch:]version-release.arch`) rather than a bare
 * version string — verified against the same `fedora:latest` container:
 * `dnf repoquery --qf '%{name}-%{evr}.%{arch}\n' tree` printed
 * `tree-2.2.1-4.fc44.aarch64`, `dnf install -y tree-2.2.1-4.fc44.aarch64`
 * installed exactly that build, and `dnf install -y
 * tree-999.999.999-1.fc44.x86_64` failed with `Failed to resolve the
 * transaction: No match for argument: tree-999.999.999-1.fc44.x86_64` (dnf5's
 * own suggestion, `--skip-unavailable`, would silently drop the package from
 * the transaction rather than fail it — not used here, since a silently
 * dropped pin is worse than a loud failure).
 *
 * `Exact.version` is therefore expected to be a full NEVRA string
 * (`2.2.1-4.fc44.aarch64`, or `2:4.19.0-7.fc44.aarch64` when a package
 * carries a nonzero epoch, e.g. `shadow-utils` in the same repoquery output)
 * for `install` to combine with `name` — not a bare upstream version like
 * `"2.2.1"`, which dnf's own resolver does not accept as an install target
 * the way apt's `pkg=1.2.3` does.
 *
 * `canDowngrade`: not independently re-verified (the container above only
 * exercised installing a NEVRA that was already current), but real dnf
 * documents `dnf downgrade`/an explicit older NEVRA passed to `install` as
 * genuine downgrade paths, contingent — like apt — on that build still being
 * present in a configured repo's metadata. `true`, with the same caveat as
 * `Apt.ts`.
 */
export const dnfVersionSupport: PackageVersionSupport = {
  accepts: new Set(["Exact"]),
  canDowngrade: true,
};

const rejectSpec = rejectUnsupportedVersionSpec("dnf", dnfVersionSupport);

/**
 * Fedora/RHEL. Same sudo caveat as Apt.ts.
 *
 * Verified against `docker run --rm fedora:latest` (Fedora 44, which ships
 * `dnf5` — `/usr/bin/dnf` is a symlink to it, and dnf5 keeps the dnf4
 * `repoquery`/`install` CLI surface used here). `dnf repoquery
 * --userinstalled --qf '%{name}\n'` printed the base image's own packages
 * (`bash`, `coreutils`, `rpm`, …) on a fresh container, exited 0, and picked
 * up `tree` immediately after `dnf install -y tree`. RHEL/CentOS on dnf4 is
 * not independently checked, but this is exactly the CLI surface dnf5's own
 * compatibility layer targets, so it isn't expected to differ.
 */
/** Declared here rather than inline at each `exec`, the same way this
 * backend's `versions` is: one statement of what this tool's own work costs. */
const dnfTimeouts: PackageTimeouts = {
  install: Timeouts.systemPackage,
  refresh: Timeouts.indexRefresh,
};

export const makeDnfBackend = (): PackageManagerBackend => ({
  id: "dnf",
  executable: "dnf",
  shell: "posix",
  versions: dnfVersionSupport,
  timeouts: dnfTimeouts,
  /**
   * `%{name}\t%{evr}\n` — verified in the same container: a tab-separated
   * `name\tevr` pair per package (`tree\t2.2.1-4.fc44`,
   * `shadow-utils\t2:4.19.0-7.fc44` with its nonzero epoch prefix intact).
   * `evr` (epoch:version-release) omits `.arch`, unlike the NEVRA `install`
   * pins by — this repo's own `install`, above, builds the full pin from
   * `name-evr.arch`, but what a listing reports and what a pin is spelled as
   * are not required to be byte-identical for `matches` to compare them
   * sensibly; both are dnf's own canonical rendering of "this build".
   */
  list: (exec) =>
    exec({
      command: Sh.sh("dnf", "repoquery", "--userinstalled", "--qf", "%{name}\\t%{evr}\\n"),
      shell: true,
    }).pipe(
      Effect.map((result) =>
        lines(result.stdout).map((line): PackageEntry => {
          const tab = line.indexOf("\t");
          return tab === -1
            ? { name: line }
            : { name: line.slice(0, tab), version: line.slice(tab + 1) };
        }),
      ),
    ),
  install: (name, version, exec, execution) =>
    UndefinedOr.match(version, {
      onUndefined: () =>
        exec({
          command: Sh.sh(...elevated(execution, "dnf", "install", "-y", name)),
          shell: true,
          timeout: dnfTimeouts.install,
        }).pipe(Effect.asVoid),
      onDefined: (spec) =>
        Match.value(spec).pipe(
          Match.tagsExhaustive({
            Exact: (v) =>
              exec({
                command: Sh.sh(
                  ...elevated(execution, "dnf", "install", "-y", `${name}-${v.version}`),
                ),
                shell: true,
                timeout: dnfTimeouts.install,
              }).pipe(Effect.asVoid),
            AtLeast: rejectSpec,
            Channel: rejectSpec,
            Digest: rejectSpec,
          }),
        ),
    }),
  /**
   * `dnf makecache` refreshes dnf's own metadata cache ahead of an install
   * that needs a NEVRA not in it yet — dnf5 refreshes metadata automatically
   * based on a TTL (`metadata_expire`, default 48h in `dnf.conf`) rather than
   * failing outright the way a stale apt/pacman index does, so this is a
   * narrower, more defensive gap than `Apt.ts`'s or `Pacman.ts`'s: within that
   * TTL window `dnf install` already refreshes what it needs on its own. This
   * makes it explicit rather than relying on the TTL happening to have
   * expired favourably, at the cost of one extra network round-trip per
   * apply. `dnf makecache` never touches installed packages the way pacman's
   * `-Sy` sync raises a partial-upgrade concern for (see `Pacman.ts`) — it
   * only refreshes repository metadata.
   */
  refreshIndex: (exec, execution) =>
    exec({
      command: Sh.sh(...elevated(execution, "dnf", "makecache")),
      shell: true,
      timeout: dnfTimeouts.refresh,
    }).pipe(Effect.asVoid),
});

/** dnf's COPR half — see `Repo.ts`'s `RepoSpec` for the `project` field's `owner/project` shape. */
export const makeDnfRepoBackend = (): RepoBackend<DnfRepo> => ({
  /**
   * COPR (`dnf copr list`) is dnf's real equivalent of a brew tap or an apt
   * PPA: a third-party repo a user opts into by name. Verified on the same
   * Fedora 44 container — `dnf copr enable -y atim/lazygit` wrote
   * `/etc/yum.repos.d/_copr:copr.fedorainfracloud.org:atim:lazygit.repo` and
   * made `dnf install -y lazygit` resolve from it, and `dnf copr list`
   * printed exactly one clean line per enabled project:
   * `copr.fedorainfracloud.org/atim/lazygit` (`hub/owner/project`). The copr
   * plugin ships built into dnf5's base image; on a dnf4 system (RHEL) it may
   * need `dnf install -y dnf-plugins-core` first — not verified here.
   *
   * A recipe names a COPR as `owner/project` (the form `dnf copr enable`
   * itself documents as primary), but `dnf copr list` always reports the
   * `hub/owner/project` form. Reporting both the raw line and its trailing
   * `owner/project` suffix as two separate entries — the same two-forms
   * approach `Apt.ts`'s `listRepos` uses for `ppa:` shorthand vs. the raw
   * source line — means `Repo.ts`'s reconciler matches the common case
   * without this backend needing bespoke matching logic.
   */
  listRepos: (exec) =>
    exec({ command: Sh.sh("dnf", "copr", "list"), shell: true }).pipe(
      Effect.map((result) => {
        const repos: DnfRepo[] = [];
        for (const line of lines(result.stdout)) {
          repos.push({ _tag: "Dnf", project: line });
          const segments = line.split("/");
          if (segments.length >= 2)
            repos.push({ _tag: "Dnf", project: segments.slice(-2).join("/") });
        }
        return repos;
      }),
    ),
  addRepo: (repo, exec, execution) =>
    exec({
      command: Sh.sh(...elevated(execution, "dnf", "copr", "enable", "-y", repo.project)),
      shell: true,
    }).pipe(Effect.asVoid),
});
