import { type VersionSpec, Sh, Timeouts } from "@machine-run/core";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as UndefinedOr from "effect/UndefinedOr";
import {
  elevated,
  NO_VERSION_SUPPORT,
  rejectUnsupportedVersionSpec,
  type PackageEntry,
  type PackageManagerBackend,
  type PackageTimeouts,
} from "../../Backend.ts";
import { lines } from "../../parse.ts";

/**
 * Mac App Store CLI. A package's `name` here is the numeric App Store ID
 * (e.g. `"937984704"`), not the app's display name — that's the only
 * identifier `mas install` itself accepts, and the only stable column
 * `mas list` prints.
 *
 * Verified on this real, already-signed-in machine (`mas` 7.0.0, installed
 * via `brew install mas`) — `mas list` printed real, currently-installed
 * App Store apps, re-captured as `test/fixtures/mas-list.txt` (re-run
 * confirmed the same shape with four more apps than the first capture):
 * ```
 *  937984704  Amphetamine  (5.3.2)
 *  640199958  Developer    (11.0.2)
 *  361304891  Numbers      (15.1)
 *  490179405  Okta Verify  (9.67.1)
 *  361309726  Pages        (15.1.1)
 *  899247664  TestFlight   (4.3.0)
 * 6757482822  VVTerm       (2.14)
 * ```
 * Each line is `<right-aligned id>  <left-padded name>  (<version>)`; the
 * padding varies per column with the widest value, but the id is always the
 * first whitespace-delimited token once the line is trimmed, so
 * `firstTokens`/`lines` need no bespoke filtering the way `Winget.ts`'s
 * fixed-width table does. The trailing `(<version>)` is a real, stable
 * column too — `parseMasList` now also reports it, for observability only:
 * `mas` has no way to *request* a version at all (see `versions` below), so
 * nothing here ever compares against it.
 *
 * `install` was *not* run here, on a second look as well as the first:
 * unlike every other backend verified by actually installing something
 * disposable, `mas install` would durably add a real app to this machine's
 * real Apple ID — the kind of side effect `AGENTS.md` reserves for
 * something the user actually asked for, not something a verification pass
 * gets to decide on its own. This boundary is a deliberate, permanent
 * non-goal for this backend, not a gap waiting on more time. The command
 * below (`mas install <id>`, needing root) is instead verified against a
 * freshly re-run `mas install --help`'s own text: "Install previously
 * gotten apps from the App Store" / "Requires root privileges to install
 * apps" — unchanged from the first verification. A recipe using this
 * backend still needs the machine already signed into an Apple ID through
 * the App Store app itself — `mas` dropped its own `signin` command years
 * ago, and nothing here should try to automate that (see `AGENTS.md` rule
 * 8's "never automate authentication" for the same principle applied to
 * secrets).
 *
 * `versions` is {@link NO_VERSION_SUPPORT}: `mas install` takes an App Store
 * id and nothing else — there is no flag, and no second CLI, for "give me
 * an older release of this app". A recipe naming a `version` for `mas`
 * fails loudly with `UnsupportedVersionSpec` rather than the pin being
 * silently dropped.
 */
export const parseMasList = (stdout: string): PackageEntry[] => {
  const entries: PackageEntry[] = [];
  for (const line of lines(stdout)) {
    const id = line.split(/\s+/)[0];
    if (id === undefined || id.length === 0) continue;
    const versionMatch = line.match(/\(([^()]+)\)\s*$/);
    if (versionMatch === null) {
      entries.push({ name: id });
      continue;
    }
    entries.push({ name: id, version: versionMatch[1] });
  }
  return entries;
};

/** Declared here rather than inline at each `exec`, the same way this
 * backend's `versions` is: one statement of what this tool's own work costs. */
const masTimeouts: PackageTimeouts = {
  install: Timeouts.systemPackage,
  refresh: Timeouts.indexRefresh,
};

export const makeMasBackend = (): PackageManagerBackend => ({
  id: "mas",
  executable: "mas",
  shell: "posix",
  versions: NO_VERSION_SUPPORT,
  timeouts: masTimeouts,
  list: (exec) =>
    exec({ command: Sh.sh("mas", "list") }).pipe(
      Effect.map((result) => parseMasList(result.stdout)),
    ),
  install: (name, version: VersionSpec | undefined, exec, execution) =>
    UndefinedOr.match(version, {
      onUndefined: () =>
        exec({
          command: Sh.sh(...elevated(execution, "mas", "install", name)),
          shell: true,
          timeout: masTimeouts.install,
        }).pipe(Effect.asVoid),
      onDefined: (spec: VersionSpec) => {
        const reject = rejectUnsupportedVersionSpec("mas", NO_VERSION_SUPPORT);
        return Match.value(spec).pipe(
          Match.tagsExhaustive({
            Exact: (s) => reject(s),
            AtLeast: (s) => reject(s),
            Channel: (s) => reject(s),
            Digest: (s) => reject(s),
          }),
        );
      },
    }),
});
