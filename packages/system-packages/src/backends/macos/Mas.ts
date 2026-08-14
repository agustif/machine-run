import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import type { PackageManagerBackend } from "../../Backend.ts";
import { firstTokens, lines } from "../../parse.ts";

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
 * fixed-width table does.
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
 */
export const makeMasBackend = (): PackageManagerBackend => ({
  id: "mas",
  list: (exec) =>
    exec({ command: "mas list" }).pipe(Effect.map((result) => firstTokens(lines(result.stdout)))),
  install: (name, exec) =>
    exec({
      command: Sh.sh("sudo", "mas", "install", name),
      shell: true,
      timeout: "10 minutes",
    }).pipe(Effect.asVoid),
});
