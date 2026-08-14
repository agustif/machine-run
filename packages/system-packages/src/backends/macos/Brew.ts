import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import * as UndefinedOr from "effect/UndefinedOr";
import {
  type BrewRepo,
  NO_VERSION_SUPPORT,
  type PackageEntry,
  type PackageManagerBackend,
  rejectUnsupportedVersionSpec,
  type RepoBackend,
} from "../../Backend.ts";
import { lines } from "../../parse.ts";

/**
 * Homebrew has no way to pin `install` to an arbitrary version at all — this
 * is a real, confirmed *absence*, not an oversight to patch around.
 * `brew install <formula>` always resolves whatever the tap's current
 * formula file builds; the only way to get an older major of something is a
 * separately maintained *formula with a different name*
 * (`node@18`, `python@3.11`) — verified on this real machine: `brew info
 * node@18` shows it as its own, wholly separate formula (`keg-only`,
 * currently `Deprecated because it is not supported upstream!`), not a
 * version argument to `node`'s own formula. `brew pin` (`brew pin --help`,
 * same machine) is the other candidate that turns out not to fit: it stops
 * an *already-installed* formula from being touched by `brew upgrade`, it
 * does not select which version gets installed in the first place. A recipe
 * that wants an older major of a brew formula therefore has to name that
 * different formula in `Package.name` itself (`"node@18"`) — a name choice,
 * not a `VersionSpec` this backend could honour.
 */
export const brewVersionSupport = NO_VERSION_SUPPORT;

const rejectSpec = rejectUnsupportedVersionSpec("brew", brewVersionSupport);

export const makeBrewBackend = (): PackageManagerBackend => ({
  id: "brew",
  versions: brewVersionSupport,
  /**
   * `--full-name` is load-bearing, not cosmetic: plain `brew list --formula`
   * reports every formula by its bare name regardless of which tap it came
   * from, so a recipe naming a third-party formula `owner/tap/formula`
   * (which `install` below needs, to disambiguate from a same-named
   * `homebrew/core` formula) would never find itself in that listing and
   * would reinstall on every apply. Verified locally: after
   * `brew tap koekeishiya/formulae && brew install
   * koekeishiya/formulae/skhd`, `brew list --formula` reported it as the
   * bare `skhd`, while `brew list --formula --full-name` reported
   * `koekeishiya/formulae/skhd` — and, for formulae actually from
   * `homebrew/core` (the implicit default tap), still reported the bare
   * name with no `homebrew/core/` prefix, so this doesn't break a recipe
   * that names a core formula without a tap.
   *
   * No `version` reported: `--full-name` and `--versions` are mutually
   * exclusive — verified on this real machine, `brew list --formula
   * --full-name --versions` prints brew's own usage text instead of a
   * listing. Keeping `--full-name` (load-bearing, see above) means giving up
   * the version column `--versions` alone would add; since `brewVersionSupport`
   * accepts no `VersionSpec` tag anyway, there is nothing for `matches` to
   * compare a reported version against here regardless.
   */
  list: (exec) =>
    exec({ command: Sh.sh("brew", "list", "--formula", "--full-name") }).pipe(
      Effect.map((result) => lines(result.stdout).map((name): PackageEntry => ({ name }))),
    ),
  install: (name, version, exec) =>
    UndefinedOr.match(version, {
      onUndefined: () =>
        exec({
          command: Sh.sh("brew", "install", name),
          shell: true,
          timeout: "10 minutes",
        }).pipe(Effect.asVoid),
      onDefined: rejectSpec,
    }),
});

const toBrewRepo = (tap: string): BrewRepo => ({ _tag: "Brew", tap });

/** `brew tap`'s repo half — see `Repo.ts`'s `RepoSpec` for the `tap` field's `owner/name` shape. */
export const makeBrewRepoBackend = (): RepoBackend<BrewRepo> => ({
  listRepos: (exec) =>
    exec({ command: Sh.sh("brew", "tap") }).pipe(
      Effect.map((result) => lines(result.stdout).map(toBrewRepo)),
    ),
  addRepo: (repo, exec) =>
    exec({ command: Sh.sh("brew", "tap", repo.tap), shell: true }).pipe(Effect.asVoid),
});

/**
 * Verified read-only against this real machine's real cask installs
 * (`test/fixtures/brew-list-cask.txt`, thirteen casks, no `brew install`
 * run to produce it — every one was already installed). `brew list --cask`
 * prints exactly one bare cask token per line: no header, no version
 * column, no tap qualifier the way an unqualified `brew list --formula`
 * lacks one too — casks don't get the tap-name ambiguity formulae do here
 * because every installed cask happens to come from the default
 * `homebrew/cask` tap, so the same plain `lines()` parser formula's
 * unqualified case would use is exactly right, unlike formula's
 * `--full-name` fix. Installing a cask can additionally need a GUI prompt
 * or admin password (notarization/Gatekeeper, or a pkg installer some casks
 * shell out to) that this backend's `install` cannot satisfy unattended —
 * a real difference from a formula install, worth knowing even though nothing
 * here installs anything to prove it.
 *
 * `brew install --cask` has the identical absence of version pinning as
 * formulae (`brewVersionSupport`/`NO_VERSION_SUPPORT` above) — casks are not
 * even versioned by a `name@version` convention the way `node@18` is for
 * formulae; there is exactly one cask per app, always pointing at whatever
 * the cask definition currently downloads.
 */
export const makeBrewCaskBackend = (): PackageManagerBackend => ({
  id: "brew-cask",
  versions: brewVersionSupport,
  /**
   * Unlike formula's `list`, `--cask` has no `--full-name` fix to protect,
   * so `--versions` is free to add here — verified on this real machine:
   * `brew list --cask --versions` prints `<name> <version>` pairs (e.g.
   * `ghostty 1.3.1`), including the literal string `latest` for a cask that
   * declares no real version (`jdownloader latest`, observed on this
   * machine's own installs) — reported as-is rather than treated as absent,
   * since `matches` never compares against it here regardless
   * (`brewVersionSupport` accepts no `VersionSpec` tag).
   */
  list: (exec) =>
    exec({ command: Sh.sh("brew", "list", "--cask", "--versions") }).pipe(
      Effect.map((result) =>
        lines(result.stdout).map((line): PackageEntry => {
          const spaceIndex = line.indexOf(" ");
          return spaceIndex === -1
            ? { name: line }
            : { name: line.slice(0, spaceIndex), version: line.slice(spaceIndex + 1) };
        }),
      ),
    ),
  install: (name, version, exec) =>
    UndefinedOr.match(version, {
      onUndefined: () =>
        exec({
          command: Sh.sh("brew", "install", "--cask", name),
          shell: true,
          timeout: "10 minutes",
        }).pipe(Effect.asVoid),
      onDefined: rejectSpec,
    }),
});
