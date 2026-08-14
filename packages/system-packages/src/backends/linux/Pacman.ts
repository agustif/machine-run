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
 * `pacman -S name=version` is real, accepted syntax — but Arch's official
 * repos hold exactly one build of each package at a time, so it only ever
 * succeeds when `version` happens to equal whatever is currently in the
 * synced database. Verified against `docker run --rm --platform linux/amd64
 * archlinux:latest`: after `pacman -Sy`, `pacman -Si tree` reported
 * `Version : 2.3.2-1`; `pacman -S --noconfirm tree=2.3.2-1` (the current
 * version) installed cleanly, but `pacman -S --noconfirm tree=1.0.0-1` (an
 * older, real-looking version string) failed outright with
 * `error: target not found: tree=1.0.0-1` — pacman does not even recognise
 * it as "tree, wrong version", it reports no such target exists at all.
 *
 * `canDowngrade: false` follows directly from that: there is no repo history
 * to fall back to, so a pin can only ever succeed by accident (naming
 * whatever build happens to be current right now) and can never survive the
 * next `pacman -Syu` anyone else runs. `Package.ts`'s `apply` checks this
 * before ever shelling out, rather than let every one of these attempts fail
 * with the same opaque "target not found" for a reason specific to Arch that
 * a generic `CommandError` would not explain.
 */
export const pacmanVersionSupport: PackageVersionSupport = {
  accepts: new Set(["Exact"]),
  canDowngrade: false,
};

const rejectSpec = rejectUnsupportedVersionSpec("pacman", pacmanVersionSupport);

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
/** Declared here rather than inline at each `exec`, the same way this
 * backend's `versions` is: one statement of what this tool's own work costs. */
const pacmanTimeouts: PackageTimeouts = {
  install: Timeouts.systemPackage,
  refresh: Timeouts.indexRefresh,
};

export const makePacmanBackend = (): PackageManagerBackend => ({
  id: "pacman",
  executable: "pacman",
  shell: "posix",
  versions: pacmanVersionSupport,
  timeouts: pacmanTimeouts,
  /**
   * `pacman -Q` (without `-q`) prints `<name> <version>` pairs — verified in
   * the same container: `pacman -Q tree` → `tree 2.3.2-1`, versus `pacman -Qq
   * tree` → bare `tree`. Dropping `-q` reports the version for free with no
   * second command.
   */
  list: (exec) =>
    exec({ command: Sh.sh("pacman", "-Q") }).pipe(
      Effect.map((result) =>
        lines(result.stdout).map((line): PackageEntry => {
          const [name, version] = line.split(/\s+/);
          return name === undefined
            ? { name: line }
            : version === undefined
              ? { name }
              : { name, version };
        }),
      ),
    ),
  install: (name, version, exec, execution) =>
    UndefinedOr.match(version, {
      onUndefined: () =>
        exec({
          command: Sh.sh(...elevated(execution, "pacman", "-S", "--noconfirm", name)),
          shell: true,
          timeout: pacmanTimeouts.install,
        }).pipe(Effect.asVoid),
      onDefined: (spec) =>
        Match.value(spec).pipe(
          Match.tagsExhaustive({
            Exact: (v) =>
              exec({
                command: Sh.sh(
                  ...elevated(execution, "pacman", "-S", "--noconfirm", `${name}=${v.version}`),
                ),
                shell: true,
                timeout: pacmanTimeouts.install,
              }).pipe(Effect.asVoid),
            AtLeast: rejectSpec,
            Channel: rejectSpec,
            Digest: rejectSpec,
          }),
        ),
    }),
  /**
   * `pacman -Sy` — refreshes the synced package databases `-Qq`/`-S` read
   * from. Real and necessary: this module's own doc comment above already
   * shows `pacman -Sy` being run by hand before every verification in this
   * file, because plain `pacman -S <pkg>` against an unsynced database fails
   * outright (`error: target not found`) the same way apt does against a
   * stale index — `install` above had never actually exercised that cold-start
   * path on its own before this field existed.
   *
   * **This is `-Sy`, deliberately not `-Syu`.** Arch's own documentation
   * warns against exactly what `-Sy` alone does — syncing the package
   * database without also upgrading already-installed packages ("partial
   * upgrade") can let a newly-installed package pull in a shared library at
   * a version incompatible with what every other installed package still
   * expects, corrupting the system in a way this resource has no way to
   * detect or undo. `-Syu` (sync **and** upgrade everything) is the
   * documented-safe alternative — and is exactly what this resource will
   * not do implicitly: upgrading the *entire machine* as a side effect of
   * declaring one `System.Package` is a far bigger, unrelated blast radius
   * than installing that one package, and no `System.Package` recipe asked
   * for a whole-system upgrade. This is a real, acknowledged gap, not a
   * silent one: a pacman-managed machine whose database has drifted far
   * enough from its installed packages can still hit real dependency
   * conflicts `refreshIndex` does not protect against. See `docs/TASKS.md`.
   */
  refreshIndex: (exec, execution) =>
    exec({
      command: Sh.sh(...elevated(execution, "pacman", "-Sy", "--noconfirm")),
      shell: true,
      timeout: pacmanTimeouts.refresh,
    }).pipe(Effect.asVoid),
});
