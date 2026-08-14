import { Sh, Timeouts } from "@machine-run/core";
import * as Effect from "effect/Effect";
import * as UndefinedOr from "effect/UndefinedOr";
import {
  elevated,
  NO_VERSION_SUPPORT,
  type PackageEntry,
  type PackageManagerBackend,
  type PackageVersionSupport,
  rejectUnsupportedVersionSpec,
  type PackageTimeouts,
} from "../../Backend.ts";
import { lines } from "../../parse.ts";

/**
 * `NO_VERSION_SUPPORT`, not a guess at a pin syntax: MacPorts is not
 * installed on this Mac (`which port` finds nothing) and, unlike every Linux
 * manager this package wraps, there is no Docker image for it — MacPorts is
 * macOS-only, so a container cannot stand in for a real target the way
 * `docker run --rm archlinux:latest` does for pacman. `port installed`'s
 * shape (below) is verified only against real captured output already
 * committed to this repo before this session; a version-pin flag was never
 * run against a real `port` binary, so claiming support for one here would
 * be exactly the kind of invented-flag certainty rule 0c warns against, not
 * a documented gap — see `TASKS.md`'s still-open "MacPorts against a real
 * `port`" item, unchanged by this session.
 */
export const portVersionSupport: PackageVersionSupport = NO_VERSION_SUPPORT;

const rejectSpec = rejectUnsupportedVersionSpec("port", portVersionSupport);

/** MacPorts — the second real option on macOS, alongside Homebrew. Install commands need `sudo` (MacPorts, unlike brew, expects root). */
/** Declared here rather than inline at each `exec`, the same way this
 * backend's `versions` is: one statement of what this tool's own work costs. */
const macPortsTimeouts: PackageTimeouts = {
  install: Timeouts.systemPackage,
  refresh: Timeouts.indexRefresh,
};

export const makePortBackend = (): PackageManagerBackend => ({
  id: "port",
  executable: "port",
  shell: "posix",
  versions: portVersionSupport,
  timeouts: macPortsTimeouts,
  list: (exec) =>
    exec({ command: Sh.sh("port", "installed"), shell: true }).pipe(
      Effect.map((result) =>
        // `port installed` prints a "The following ports are currently
        // installed:" header line, then one indented
        // `<name> @<version>_<revision> (active)` line per port. Only the
        // version-bearing lines are ports, so filter on the `@` that always
        // separates name from version before ever taking a first token.
        lines(result.stdout)
          .filter((line) => line.includes("@"))
          .map((line): PackageEntry => {
            const [name, versionToken] = line.split(/\s+/);
            return name === undefined
              ? { name: line }
              : versionToken === undefined
                ? { name }
                : { name, version: versionToken.replace(/^@/, "") };
          }),
      ),
    ),
  install: (name, version, exec, execution) =>
    UndefinedOr.match(version, {
      onUndefined: () =>
        exec({
          command: Sh.sh(...elevated(execution, "port", "install", name)),
          shell: true,
          timeout: macPortsTimeouts.install,
        }).pipe(Effect.asVoid),
      onDefined: rejectSpec,
    }),
  // `port selfupdate` syncs the local ports tree (and the `port` tool
  // itself) — MacPorts never does this on its own before `install`, unlike
  // apt/dnf. Documented (`man port`), not independently run here — no `port`
  // binary on this Mac (see this module's own doc comment).
  refreshIndex: (exec, execution) =>
    exec({
      command: Sh.sh(...elevated(execution, "port", "selfupdate")),
      shell: true,
      timeout: macPortsTimeouts.refresh,
    }).pipe(Effect.asVoid),
});
