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
