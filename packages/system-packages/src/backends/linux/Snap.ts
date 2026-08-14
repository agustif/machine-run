import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import type { PackageManagerBackend } from "../../Backend.ts";
import { firstTokens, lines } from "../../parse.ts";

/**
 * Verified against a genuinely booted `systemd` PID 1 in a container — the
 * same technique `system-services`' `systemd-user` backend used, reaching
 * `snapd` this time instead of `systemctl --user`. A plain `docker run` was
 * never going to work (`sd_booted()` fails immediately, and `apt-get install
 * snapd` alone never gets a running daemon), so the earlier "container is
 * not enough" doc comment was about a *plain* container, not containers in
 * general — it undersold what a privileged, systemd-booted one can do.
 *
 * Recipe: `docker run -d --name <build> ubuntu:24.04 sleep infinity`, then
 * inside it `apt-get install -y systemd systemd-sysv dbus-user-session
 * snapd`, `docker commit` that into an image, then
 * `docker run -d --privileged --cgroupns=host -v
 * /sys/fs/cgroup:/sys/fs/cgroup:rw <image> /sbin/init`. `systemctl
 * is-system-running` printed `running` and `ps -p 1` showed a real `systemd`
 * process — genuine PID 1, not the `sd_booted()` refusal a bare container
 * gives.
 *
 * `snap list` on a fresh install (no snaps yet) prints **nothing on
 * stdout** and exits `0`; the human-facing "No snaps are installed yet. Try
 * 'snap install hello-world'." goes to **stderr**, confirmed by redirecting
 * the two streams separately. So `list`'s empty case is genuinely an empty
 * `stdout`, never a `CommandError` — the guard below was written for exactly
 * this, and it was right.
 *
 * `snap install hello-world` (no `sudo` needed running as root in the
 * container) triggered snapd's real first-install bootstrap — pulling the
 * `snapd` and `core` base snaps first, restarting the daemon mid-install
 * ("Requested daemon restart (snapd snap)"), then finishing all three
 * installs — and the installed snap actually ran (`snap run hello-world` →
 * `Hello World!`). The populated `snap list` afterward
 * (`test/fixtures/snap-list.txt`) is the real, previously-undocumented
 * shape:
 * ```
 * Name         Version             Rev    Tracking       Publisher    Notes
 * core         16-2.61.4-20260225  17290  latest/stable  canonical**  core
 * hello-world  6.4                 29     latest/stable  canonical**  -
 * snapd        2.76.2              27709  latest/stable  canonical**  snapd
 * ```
 * One real, previously-unknown detail the documented shape didn't mention:
 * the `Publisher` column can carry a trailing `**` (Canonical's verified
 * marker) glued directly onto the name with no space, and `Notes` is `-`
 * when there is nothing to report rather than being blank — neither affects
 * `firstTokens`, which only ever reads the first column, but both are real
 * shape details now confirmed rather than assumed.
 *
 * `install` needs root (`snap install` is documented to require it, and
 * historically prompts for `sudo` itself if not already root) —
 * `sudo snap install` is the standard non-interactive form; this session's
 * container ran as root already, so `sudo` itself was not separately
 * exercised.
 */
export const parseSnapList = (stdout: string): string[] => {
  const rows = lines(stdout);
  // A fresh install's "no snaps installed" message is real, but it's on
  // stderr — confirmed by capturing stdout and stderr separately against a
  // real snapd. `exec`'s `stdout` is empty in that case, never reaching this
  // function with anything to strip, so this guard is just the ordinary
  // empty-input case, not a workaround for a message that never arrives here.
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
