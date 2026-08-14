import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import type { AptRepo, PackageManagerBackend, RepoBackend } from "../../Backend.ts";
import { lines } from "../../parse.ts";
import { parseAllSources } from "./apt/sources.ts";

/** Marks where one-line entries end and deb822 stanzas begin in one read. */
const SEPARATOR = "###machine-run:deb822###";

/**
 * Debian and Ubuntu.
 *
 * `install` and `addRepo` run as root, so a server needs either machine-run
 * running as root or passwordless sudo for these commands. A `sudo` that
 * prompts will hang: nothing here provides a terminal or a password.
 */
export const makeAptBackend = (): PackageManagerBackend => ({
  id: "apt",
  list: (exec) =>
    exec({
      command: Sh.sh("dpkg-query", "-f", "${binary:Package}\\n", "-W"),
      shell: true,
    }).pipe(Effect.map((result) => lines(result.stdout))),
  install: (name, exec) =>
    exec({
      command: Sh.sh("sudo", "apt-get", "install", "-y", name),
      shell: true,
      timeout: "10 minutes",
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
  addRepo: (repo, exec) =>
    exec({
      command: Sh.sh("sudo", "add-apt-repository", "-y", repo.ppa),
      shell: true,
    }).pipe(Effect.asVoid),
});
