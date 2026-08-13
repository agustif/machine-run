import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import type { PackageManagerBackend } from "../../Backend.ts";
import { firstTokens, lines } from "../../parse.ts";

/**
 * UNVERIFIED. `snap list`'s documented output is a header row
 * (`Name  Version  Rev  Tracking  Publisher  Notes`) followed by one row
 * per installed snap, so `firstTokens` after dropping the header — the same
 * shape `MacPorts.ts`/`Winget.ts` filter for — is the widely-documented
 * parse, but no real output was captured to confirm it.
 *
 * Snap fundamentally needs a running `snapd`, which needs systemd and its
 * own mount namespaces — not something a plain `docker run` container
 * provides, which is itself widely documented as a snap-in-Docker
 * limitation rather than something specific to this repo's setup. This was
 * still attempted directly rather than assumed: `docker run --rm
 * --platform linux/amd64 ubuntu:24.04` with `apt-get install snapd` timed
 * out repeatedly inside this session's time budget before `snap version`
 * ever returned, both with and without manually starting `snapd`. That is
 * consistent with the known limitation, not a clean confirmation of it, so
 * this stays marked unverified rather than "confirmed unsupported in
 * Docker".
 *
 * `install` needs root (`snap install` is documented to require it, and
 * historically prompts for `sudo` itself if not already root) —
 * `sudo snap install` is the standard non-interactive form.
 */
export const parseSnapList = (stdout: string): string[] => {
  const rows = lines(stdout);
  // Also UNVERIFIED: whether an empty install prints empty stdout, or
  // (as some documented versions do) a "no snaps installed" message on
  // stderr with a non-zero exit — in the latter case this function would
  // never even be reached, since a non-zero exit raises a `CommandError`
  // before `list` gets to parse anything. This guard only covers the case
  // where stdout genuinely is empty.
  if (rows.length === 0) return [];
  // The header's first column is always literally "Name" — drop it and
  // parse everything after.
  return firstTokens(rows.slice(1));
};

export const makeSnapBackend = (): PackageManagerBackend => ({
  id: "snap",
  list: (exec) =>
    exec({ command: "snap list" }).pipe(Effect.map((result) => parseSnapList(result.stdout))),
  install: (name, exec) =>
    exec({
      command: Sh.sh("sudo", "snap", "install", name),
      shell: true,
      timeout: "10 minutes",
    }).pipe(Effect.asVoid),
});
