import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import type { PackageManagerBackend } from "../../Backend.ts";
import { lines } from "../../parse.ts";

/**
 * Arch Linux. Same sudo caveat as Apt.ts. No AUR support here — see
 * `Aur.ts` for `yay`/`paru`, and its module doc comment for why the AUR
 * itself has no `System.Repo` equivalent.
 *
 * Verified against `docker run --rm --platform linux/amd64 archlinux:latest`.
 * `pacman -Qq` on a freshly-synced database printed 137 names on its own
 * line each — every installed package, dependencies included (the same
 * "installed at all, regardless of why" semantics as apt's `dpkg-query`),
 * not just explicitly-requested ones (`pacman -Qe`, unused here, is that
 * narrower set). The `warning: database file for '...' does not exist`
 * lines pacman prints before a first `-Sy` go to stderr, never stdout, so
 * they never reach this parse. Installing `tree` and re-running `-Qq`
 * picked it up immediately.
 *
 * One real container quirk unrelated to pacman itself: `pacman -Sy` failed
 * with `error: error restricting syscalls via seccomp: 22!` under this
 * sandbox's default seccomp profile, resolved with pacman's own
 * `--disable-sandbox` flag (documented in `pacman -S --help`; a Docker/CI
 * artifact of this test environment, not something `install` below needs to
 * pass on a real machine).
 */
export const makePacmanBackend = (): PackageManagerBackend => ({
  id: "pacman",
  list: (exec) =>
    exec({ command: Sh.sh("pacman", "-Qq") }).pipe(Effect.map((result) => lines(result.stdout))),
  install: (name, exec) =>
    exec({
      command: Sh.sh("sudo", "pacman", "-S", "--noconfirm", name),
      shell: true,
      timeout: "10 minutes",
    }).pipe(Effect.asVoid),
});
