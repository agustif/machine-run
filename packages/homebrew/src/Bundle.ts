import * as Dotfiles from "@machine-run/dotfiles";
import * as Command from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

/**
 * Desired Homebrew state for a machine. Deliberately flat (no per-role
 * merging) — one machine has one Brewfile.
 */
export interface BrewBundleSpec {
  taps: string[];
  brews: string[];
  casks: string[];
}

const renderBrewfile = (spec: BrewBundleSpec) =>
  [
    ...spec.taps.map((tap) => `tap "${tap}"`),
    ...spec.brews.map((brew) => `brew "${brew}"`),
    ...spec.casks.map((cask) => `cask "${cask}"`),
  ].join("\n") + "\n";

/**
 * Reconciles Homebrew's installed formulas/casks/taps to `spec` by writing a
 * generated Brewfile (via {@link Dotfiles.File}) and running `brew bundle`
 * against it (via alchemy's own `Command.Exec`).
 *
 * There is no custom `Homebrew.Bundle` resource here on purpose: `brew
 * bundle` is already an idempotent upsert, and `Command.Exec` already
 * memoizes by hashing its `cwd`'s file contents — pointing `cwd` at a
 * directory containing only the generated Brewfile means `brew bundle` only
 * actually re-runs when the desired package set changes. Reusing that native
 * primitive is simpler and safer than reimplementing brew's own diffing.
 *
 * `dir` should be a stable, dedicated directory (e.g.
 * `<app>/.generated/homebrew`) — it holds nothing but the generated Brewfile.
 */
export const brewBundle = (id: string, spec: BrewBundleSpec, dir: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const brewfilePath = path.join(dir, "Brewfile");

    yield* Dotfiles.File(`${id}-brewfile`, {
      path: brewfilePath,
      content: renderBrewfile(spec),
    });

    yield* Command.Exec(`${id}-brew-bundle`, {
      cwd: dir,
      command: "brew bundle --file=./Brewfile",
    });
  });
