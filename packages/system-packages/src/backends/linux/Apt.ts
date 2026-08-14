import { Sh, Timeouts } from "@machine-run/core";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as UndefinedOr from "effect/UndefinedOr";
import {
  type AptRepo,
  elevated,
  type PackageEntry,
  type PackageManagerBackend,
  type PackageVersionSupport,
  rejectUnsupportedVersionSpec,
  type RepoBackend,
  type PackageTimeouts,
} from "../../Backend.ts";
import { lines } from "../../parse.ts";
import { parseAllSources } from "./apt/sources.ts";

/** Marks where one-line entries end and deb822 stanzas begin in one read. */
const SEPARATOR = "###machine-run:deb822###";

/**
 * `apt-get install pkg=version` is real, verified syntax: `docker run --rm
 * ubuntu:24.04` — `apt-cache madison tree` listed two real available
 * versions (`2.1.1-2ubuntu3.24.04.2` and the unpatched `2.1.1-2ubuntu3`),
 * `apt-get install -y tree=2.1.1-2ubuntu3.24.04.2` installed that exact one,
 * and `apt-get install -y tree=999.999.999-nonexistent` failed with
 * `E: Version '999.999.999-nonexistent' for 'tree' was not found` (also
 * `Package tree is not available, but is referred to by another package` on
 * the line above it) rather than silently installing whatever the candidate
 * version happened to be.
 *
 * `canDowngrade: true` because `apt-get install pkg=olderversion` is
 * documented and real apt behaviour for moving an installed package
 * *backward*, not just choosing among not-yet-installed candidates — but
 * this is honestly qualified: it only succeeds while that older `.deb` is
 * still present in a configured repo's `Packages` index. Ubuntu's archive
 * kept both a base release and a point-release build available in the same
 * madison listing above, but does not keep unbounded history — a version
 * that has aged out of every configured repo fails exactly like the
 * nonexistent-version case above, with no way for this backend to tell "too
 * old to still be hosted" apart from "never existed".
 */
export const aptVersionSupport: PackageVersionSupport = {
  accepts: new Set(["Exact"]),
  canDowngrade: true,
};

const rejectSpec = rejectUnsupportedVersionSpec("apt", aptVersionSupport);

/** Declared here rather than inline at each `exec`, the same way this
 * backend's `versions` is: one statement of what this tool's own work costs. */
const aptTimeouts: PackageTimeouts = { install: Timeouts.systemPackage, refresh: Timeouts.indexRefresh };

export const makeAptBackend = (): PackageManagerBackend => ({
  id: "apt",
  versions: aptVersionSupport,
  timeouts: aptTimeouts,
  /**
   * `dpkg-query -f '${binary:Package}\t${Version}\n' -W` — verified against
   * the same `ubuntu:24.04` container: `bash\t5.2.21-2ubuntu4` and
   * `tree\t2.1.1-2ubuntu3.24.04.2`, tab-separated, one pair per installed
   * package. Adding `\t${Version}` to the format string this already used is
   * the only change needed; the name-only column this previously reported
   * was already the left half of the same line.
   */
  list: (exec) =>
    exec({
      command: Sh.sh("dpkg-query", "-f", "${binary:Package}\\t${Version}\\n", "-W"),
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
          command: Sh.sh(...elevated(execution, "apt-get", "install", "-y", name)),
          shell: true,
          timeout: aptTimeouts.install,
        }).pipe(Effect.asVoid),
      onDefined: (spec) =>
        Match.value(spec).pipe(
          Match.tagsExhaustive({
            Exact: (v) =>
              exec({
                command: Sh.sh(
                  ...elevated(execution, "apt-get", "install", "-y", `${name}=${v.version}`),
                ),
                shell: true,
                timeout: aptTimeouts.install,
              }).pipe(Effect.asVoid),
            AtLeast: rejectSpec,
            Channel: rejectSpec,
            Digest: rejectSpec,
          }),
        ),
    }),
  /**
   * `apt-get update` — refreshes `/var/lib/apt/lists` from every configured
   * source. Real and necessary, not defensive boilerplate: a fresh
   * `ubuntu:24.04` image's baked-in index is already stale by the time this
   * runs, and `apt-get install -y tree` against it fails outright with
   * `E: Unable to locate package tree` even though `tree` exists in every
   * configured repo — confirmed by running `install` before ever calling
   * `apt-get update` in the same fresh container `list`/`install` above were
   * verified in. Running `apt-get update` first (`docker run --rm
   * ubuntu:24.04`, exit 0, ~30s fetching `Packages`/`Release` files from
   * `archive.ubuntu.com`) is what makes every install above resolve at all.
   * Unlike pacman's `-Sy` (see `Pacman.ts`), refreshing apt's index carries no
   * "partial upgrade" hazard — apt resolves the *whole* dependency graph
   * fresh on every `install`, it does not leave some packages' metadata
   * stale relative to others the way pacman's binary-package model can.
   */
  refreshIndex: (exec, execution) =>
    exec({
      command: Sh.sh(...elevated(execution, "apt-get", "update")),
      shell: true,
      timeout: aptTimeouts.refresh,
    }).pipe(Effect.asVoid),
});

const toAptRepo = (ppa: string): AptRepo => ({ _tag: "Apt", ppa });

/** apt's PPA half — see `Repo.ts`'s `RepoSpec` for the `ppa` field's shape. */
export const makeAptRepoBackend = (): RepoBackend<AptRepo> => ({
  /**
   * Reads the files apt is configured from, in both of its formats.
   *
   * The one-line entries and the deb822 stanzas are read in one command with a
   * sentinel between them: they need different parsers, and concatenating them
   * first would leave no way to tell where one format ends. Both globs are
   * `2>/dev/null; true` guarded, because a machine legitimately has one of the
   * two unpopulated and an empty repository set is an answer, not a failure.
   */
  listRepos: (exec) =>
    exec({
      // A fixed, multi-statement shell script: two unquoted globs that must
      // expand, a fixed `SEPARATOR` sentinel (not a caller-supplied value),
      // and a trailing `true` so an unpopulated glob's exit code doesn't fail
      // the whole read (see the doc comment above). `Sh.sh` cannot express
      // this — its per-argument quoting would quote the globs and the `;`
      // separators right out of meaning.
      command: Sh.unsafeRaw(
        [
          "cat /etc/apt/sources.list /etc/apt/sources.list.d/*.list 2>/dev/null",
          `echo '${SEPARATOR}'`,
          "cat /etc/apt/sources.list.d/*.sources 2>/dev/null",
          "true",
        ].join("; "),
        "fixed multi-statement shell script joining two glob reads with a fixed sentinel; not expressible as a single argv-quoted command",
      ),
      shell: true,
    }).pipe(
      Effect.map((result) => {
        const index = result.stdout.indexOf(SEPARATOR);
        const oneLine = index === -1 ? result.stdout : result.stdout.slice(0, index);
        const deb822 = index === -1 ? "" : result.stdout.slice(index + SEPARATOR.length);
        return parseAllSources(oneLine, deb822).map(toAptRepo);
      }),
    ),
  addRepo: (repo, exec, execution) =>
    exec({
      command: Sh.sh(...elevated(execution, "add-apt-repository", "-y", repo.ppa)),
      shell: true,
    }).pipe(Effect.asVoid),
});
