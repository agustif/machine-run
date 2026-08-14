import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import type { BrewRepo, PackageManagerBackend, RepoBackend } from "../../Backend.ts";
import { lines } from "../../parse.ts";

export const makeBrewBackend = (): PackageManagerBackend => ({
  id: "brew",
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
   */
  list: (exec) =>
    exec({ command: "brew list --formula --full-name" }).pipe(
      Effect.map((result) => lines(result.stdout)),
    ),
  install: (name, exec) =>
    exec({
      command: Sh.sh("brew", "install", name),
      shell: true,
      timeout: "10 minutes",
    }).pipe(Effect.asVoid),
});

const toBrewRepo = (tap: string): BrewRepo => ({ _tag: "Brew", tap });

/** `brew tap`'s repo half — see `Repo.ts`'s `RepoSpec` for the `tap` field's `owner/name` shape. */
export const makeBrewRepoBackend = (): RepoBackend<BrewRepo> => ({
  listRepos: (exec) =>
    exec({ command: "brew tap" }).pipe(
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
 */
export const makeBrewCaskBackend = (): PackageManagerBackend => ({
  id: "brew-cask",
  list: (exec) =>
    exec({ command: "brew list --cask" }).pipe(Effect.map((result) => lines(result.stdout))),
  install: (name, exec) =>
    exec({
      command: Sh.sh("brew", "install", "--cask", name),
      shell: true,
      timeout: "10 minutes",
    }).pipe(Effect.asVoid),
});
