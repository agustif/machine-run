import { Sh, Timeouts } from "@machine-run/core";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as UndefinedOr from "effect/UndefinedOr";
import {
  type PackageEntry,
  type PackageManagerBackend,
  type PackageVersionSupport,
  rejectUnsupportedVersionSpec,
  type PackageTimeouts,
} from "../../Backend.ts";
import { lines } from "../../parse.ts";

/**
 * `gem install --user-install <name> -v <version>` — verified against
 * `docker run --rm ruby:3.3`: `gem install --user-install rake -v 13.0.6`
 * installed exactly that version alongside the image's pre-existing
 * `rake (13.1.0)` (gem keeps every installed version side by side rather than
 * replacing), and `gem install --user-install rake -v 999.999.999` failed
 * with `ERROR:  Could not find a valid gem 'rake' (= 999.999.999) in any
 * repository` / `ERROR:  Possible alternatives: rake`.
 *
 * `canDowngrade: true` — rubygems.org serves every published version
 * forever, so `-v <olderversion>` always succeeds if that version was ever
 * published, regardless of what is already installed (verified above:
 * installing 13.0.6 alongside an existing, newer 13.1.0 needed nothing
 * special). "Downgrade" is a slight misnomer for gem specifically, since
 * installing an older version does not remove the newer one — see `list`'s
 * doc comment on what that means for `matches`.
 */
export const gemVersionSupport: PackageVersionSupport = {
  accepts: new Set(["Exact"]),
  canDowngrade: true,
};

const rejectSpec = rejectUnsupportedVersionSpec("gem", gemVersionSupport);

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
/**
 * `<name> (<v1>, <v2>, ...)` → `{ name, version: v1 }` — gem lists every
 * installed version of a gem on one line, newest first (verified: after
 * installing 13.0.6 alongside an already-present 13.1.0, the line read
 * `rake (13.1.0, 13.0.6)`, newest first). `PackageEntry.version` is
 * singular, so this reports only the first (newest); `matches` in
 * `Package.ts` therefore cannot see an older pinned version that is *also*
 * installed alongside a newer one — it only ever compares against whichever
 * one gem lists first. That is an acceptable gap given `install`'s
 * `canDowngrade: true` never actually removes the newer version either: the
 * two facts ("is 13.0.6 installed" and "is 13.0.6 the newest installed") are
 * different questions, and this backend only answers the second.
 */
export const parseGemList = (stdout: string): PackageEntry[] => {
  const entries: PackageEntry[] = [];
  for (const line of lines(stdout)) {
    const match = /^(\S+)\s+\(([^)]*)\)/.exec(line);
    if (match === null) continue;
    const name = match[1];
    const versions = match[2];
    if (name === undefined || versions === undefined) continue;
    const first = versions.split(",")[0]?.trim().replace(/^default:\s*/, "");
    entries.push(first !== undefined && first.length > 0 ? { name, version: first } : { name });
  }
  return entries;
};

/** Declared here rather than inline at each `exec`, the same way this
 * backend's `versions` is: one statement of what this tool's own work costs. */
const gemTimeouts: PackageTimeouts = { install: Timeouts.languagePackage, refresh: Timeouts.indexRefresh };

export const makeGemBackend = (): PackageManagerBackend => ({
  id: "gem",
  versions: gemVersionSupport,
  timeouts: gemTimeouts,
  list: (exec) =>
    exec({ command: Sh.sh("gem", "list", "--local") }).pipe(
      Effect.map((result) => parseGemList(result.stdout)),
    ),
  install: (name, version, exec) =>
    UndefinedOr.match(version, {
      onUndefined: () =>
        exec({
          command: Sh.sh("gem", "install", "--user-install", name),
          shell: true,
          timeout: gemTimeouts.install,
        }).pipe(Effect.asVoid),
      onDefined: (spec) =>
        Match.value(spec).pipe(
          Match.tagsExhaustive({
            Exact: (v) =>
              exec({
                command: Sh.sh("gem", "install", "--user-install", name, "-v", v.version),
                shell: true,
                timeout: gemTimeouts.install,
              }).pipe(Effect.asVoid),
            AtLeast: rejectSpec,
            Channel: rejectSpec,
            Digest: rejectSpec,
          }),
        ),
    }),
});
