/**
 * Whether an installed/active version satisfies a recipe's requested one.
 *
 * A version manager answers a different question than a package manager.
 * `System.Package` asks membership — "is `ripgrep` in the installed set" — and
 * one name is either there or it isn't. A runtime request is a version
 * *prefix*: `node@22` means "any `22.x.y`", `node@22.11` means "any `22.11.z`",
 * and `node@22.11.0` means exactly that. Every backend here already resolves
 * that shorthand itself — `mise use node@22`, `asdf install nodejs 22`,
 * `uv python pin 3.12` all accept a short version and pick a concrete one — so
 * this reimplements that one rule once, generically, rather than asking each
 * backend to decide on its own whether its concrete, observed version
 * satisfies what a recipe actually asked for.
 *
 * Deliberately **not** semver-range matching: no `^`, `~`, `>=`, no
 * pre-release/build-metadata handling. A recipe states a literal prefix at
 * whatever precision it cares about, the same granularity every backend's own
 * CLI accepts — nothing here tries to be smarter than that.
 *
 * A request with no dotted structure (rustup's channel names — `"stable"`,
 * `"nightly"`, `"beta"`) falls back to exact string equality, since there is
 * no version component to take a prefix of.
 */
export const versionSatisfies = (requested: string, observed: string): boolean => {
  if (requested === observed) return true;

  const DOTTED = /^\d+(\.\d+)*$/;
  if (!DOTTED.test(requested) || !DOTTED.test(observed)) return false;

  const wanted = requested.split(".");
  const actual = observed.split(".");
  // A longer request than the observed version has more components to match
  // than the version has to offer — "22.11.0" can never be satisfied by "22".
  if (wanted.length > actual.length) return false;
  return wanted.every((part, i) => part === actual[i]);
};
