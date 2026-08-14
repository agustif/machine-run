import { Sh, Timeouts } from "@machine-run/core";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as UndefinedOr from "effect/UndefinedOr";
import {
  elevated,
  type PackageEntry,
  type PackageManagerBackend,
  type PackageVersionSupport,
  rejectUnsupportedVersionSpec,
  type PackageTimeouts,
} from "../../Backend.ts";
import { lines } from "../../parse.ts";

/**
 * `snap install <name> --channel=<channel>` / `snap refresh <name>
 * --channel=<channel>` — snapd's channel grammar (`[<track>/]<risk>[/<branch>]`,
 * risk ∈ `stable`/`candidate`/`beta`/`edge`) is genuinely not the same concept
 * `Exact`/`AtLeast` model: there is no server-side history of "revision 6.4"
 * to request by version string the way a `.deb` archive holds one — a snap
 * is always installed from whichever revision its channel currently points
 * at, so `VersionSpec.Channel` (a name, never a semver) is the only tag this
 * backend accepts, matching `rustup`'s existing `channel` field in
 * `Runtime.Tool` for the identical reason.
 *
 * `--channel` is real, confirmed syntax: `docker run --rm ubuntu:24.04`
 * (`apt-get install -y snapd`, no daemon boot needed just to read `--help`
 * text) — `snap install --help` documents `--channel=` as "Use this channel
 * instead of stable", alongside `--edge`/`--beta`/`--candidate`/`--stable`
 * shorthand for the same four risk levels.
 *
 * That same `--help` output surfaced a real, deliberately-not-modelled
 * finding: `--revision=` ("Install the given revision of a snap") pins the
 * exact numeric build in `snap list`'s `Rev` column — genuinely closer to
 * `Exact` than `Channel` is. It is not used here: the same `--help` text
 * warns "a later refresh will typically undo the revision override, taking
 * the snap back to the current revision of the channel it's tracking" — a
 * revision pin is not durable against anything else on the machine running
 * `snap refresh`, which makes it a weaker guarantee than every other
 * `Exact` this package models (apt/dnf/npm/cargo/gem/go's pins all survive
 * until something *else* explicitly reinstalls over them). Claiming `Exact`
 * support on a foundation this session found documented as self-reverting
 * would be exactly the kind of invented certainty rule 0c warns against, so
 * `snap` accepts only `Channel` below, not `Exact` — a real, stated
 * limitation, not a gap awaiting more time.
 *
 * `install` tries `snap install` first (the fresh-install path this file's
 * `list` verification below already exercised) and falls back to `snap
 * refresh` only on a `CommandError` — snapd's own `install --help` says
 * nothing about an already-installed name, but the ordinary snapd CLI
 * convention (confirmed for `pipx`'s own `install` this session, see
 * `Pipx.ts`) is that a manager's plain "install" verb refuses to touch
 * something already present; `refresh` is snapd's own documented command for
 * moving an *existing* snap to a different channel. Not independently
 * confirmed against a live daemon this session (that needs the full
 * privileged systemd boot below, not just `--help` text) —
 * `canDowngrade: true` reflects `--channel`'s own symmetry (nothing in the
 * documented flag grammar distinguishes moving toward `stable` from moving
 * toward `edge`), not an observed refresh.
 */
export const snapVersionSupport: PackageVersionSupport = {
  accepts: new Set(["Channel"]),
  canDowngrade: true,
};

const rejectSpec = rejectUnsupportedVersionSpec("snap", snapVersionSupport);

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
 * The `Version` column (second) is now also read, alongside the `Tracking`
 * column (fourth — the channel a snap is actually following, e.g.
 * `latest/stable`) — `PackageEntry.version` reports `Tracking`, not
 * `Version`: a channel pin (`VersionSpec.Channel`) is compared against
 * *which channel a snap follows*, never the numeric release string a
 * publisher happens to have tagged that revision with, which is what
 * `Version` reports and is not something a recipe can even ask snap for.
 *
 * `install` needs root (`snap install` is documented to require it, and
 * historically prompts for `sudo` itself if not already root) —
 * `sudo snap install` is the standard non-interactive form; this session's
 * container ran as root already, so `sudo` itself was not separately
 * exercised.
 */
export const parseSnapList = (stdout: string): PackageEntry[] => {
  const rows = lines(stdout);
  // A fresh install's "no snaps installed" message is real, but it's on
  // stderr — confirmed by capturing stdout and stderr separately against a
  // real snapd. `exec`'s `stdout` is empty in that case, never reaching this
  // function with anything to strip, so this guard is just the ordinary
  // empty-input case, not a workaround for a message that never arrives here.
  if (rows.length === 0) return [];
  // The header's first column is always literally "Name" — drop it and
  // parse everything after.
  const entries: PackageEntry[] = [];
  for (const row of rows.slice(1)) {
    const columns = row.split(/\s+/);
    const name = columns[0];
    const tracking = columns[3];
    if (name === undefined) continue;
    entries.push(tracking === undefined ? { name } : { name, version: tracking });
  }
  return entries;
};

/** Declared here rather than inline at each `exec`, the same way this
 * backend's `versions` is: one statement of what this tool's own work costs. */
const snapTimeouts: PackageTimeouts = { install: Timeouts.systemPackage, refresh: Timeouts.indexRefresh };

export const makeSnapBackend = (): PackageManagerBackend => ({
  id: "snap",
  versions: snapVersionSupport,
  timeouts: snapTimeouts,
  list: (exec) =>
    exec({ command: Sh.sh("snap", "list") }).pipe(
      Effect.map((result) => parseSnapList(result.stdout)),
    ),
  install: (name, version, exec, execution) =>
    UndefinedOr.match(version, {
      onUndefined: () =>
        exec({
          command: Sh.sh(...elevated(execution, "snap", "install", name)),
          shell: true,
          timeout: snapTimeouts.install,
        }).pipe(Effect.asVoid),
      onDefined: (spec) =>
        Match.value(spec).pipe(
          Match.tagsExhaustive({
            Channel: (v) =>
              exec({
                command: Sh.sh(
                  ...elevated(execution, "snap", "install", name, `--channel=${v.name}`),
                ),
                shell: true,
                timeout: snapTimeouts.install,
              }).pipe(
                Effect.asVoid,
                Effect.catchTag("CommandError", () =>
                  exec({
                    command: Sh.sh(
                      ...elevated(execution, "snap", "refresh", name, `--channel=${v.name}`),
                    ),
                    shell: true,
                    timeout: snapTimeouts.install,
                  }).pipe(Effect.asVoid),
                ),
              ),
            Exact: rejectSpec,
            AtLeast: rejectSpec,
            Digest: rejectSpec,
          }),
        ),
    }),
});
