import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import type { DnfRepo, PackageManagerBackend, RepoBackend } from "../../Backend.ts";
import { lines } from "../../parse.ts";

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
export const makeDnfBackend = (): PackageManagerBackend => ({
  id: "dnf",
  list: (exec) =>
    exec({
      command: Sh.sh("dnf", "repoquery", "--userinstalled", "--qf", "%{name}\\n"),
      shell: true,
    }).pipe(Effect.map((result) => lines(result.stdout))),
  install: (name, exec) =>
    exec({
      command: Sh.sh("sudo", "dnf", "install", "-y", name),
      shell: true,
      timeout: "10 minutes",
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
  addRepo: (repo, exec) =>
    exec({
      command: Sh.sh("sudo", "dnf", "copr", "enable", "-y", repo.project),
      shell: true,
    }).pipe(Effect.asVoid),
});
