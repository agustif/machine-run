import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import type { PackageManagerBackend } from "../../Backend.ts";
import { firstTokens, lines } from "../../parse.ts";

/**
 * `gem list --local` prints one `<name> (<version>[, <version>...])` line
 * per installed gem — no header, no footer — so `firstTokens` alone
 * (splitting on whitespace, keeping only the name) is enough; there's
 * nothing to filter out the way pipx's empty-state banner needs.
 *
 * Verified locally (macOS system Ruby 2.6.10): a fresh listing printed 48
 * such lines, including both forms — `bigdecimal (default: 1.4.1)` for a
 * bundled default gem and, after `gem install --user-install rake` twice at
 * different versions, `rake (13.4.2, 13.0.6, 12.3.3)` for one with several
 * installed versions (no `--all` flag needed; `gem list --local` already
 * shows every installed version).
 *
 * Independently reverified against `docker run --rm ruby:3.3` (Ruby 3.3.12,
 * gem 3.5.22 — a different Ruby entirely, not SIP-affected): a fresh image
 * already carried one plain (non-default) `rake (13.1.0)`, and after
 * `gem install --user-install cowsay` plus two more pinned
 * `gem install --user-install rake -v <version>` calls, `gem list --local`
 * collapsed all three `rake` installs into the one expected line —
 * `rake (13.4.2, 13.1.0, 13.0.6)` — alongside a new `cowsay (0.3.0)` line,
 * for 72 total lines, confirming the parser doesn't depend on anything
 * macOS- or SIP-specific (fixture: `test/fixtures/gem-list-local.txt`,
 * captured after both installs).
 *
 * `install` uses `--user-install`: this machine's system Ruby refused a
 * plain `gem install` with `Gem::FilePermissionError` (SIP-protected gem
 * directory), and `--user-install` works whether or not that protection
 * applies, so it's the safer default — sudo is deliberately not the
 * fallback (see `AGENTS.md`'s general preference for non-root installs).
 * The tradeoff, also seen while verifying: `gem install --user-install`
 * warns that its bin directory may not be on `$PATH`
 * (`~/.gem/ruby/<ver>/bin` here), which this backend doesn't attempt to fix
 * — unlike `pipx`/`uv tool`, which manage their own shims, plain `gem`
 * leaves `$PATH` to the caller.
 */
export const makeGemBackend = (): PackageManagerBackend => ({
  id: "gem",
  list: (exec) =>
    exec({ command: "gem list --local" }).pipe(
      Effect.map((result) => firstTokens(lines(result.stdout))),
    ),
  install: (name, exec) =>
    exec({
      command: Sh.sh("gem", "install", "--user-install", name),
      shell: true,
      timeout: "5 minutes",
    }).pipe(Effect.asVoid),
});
