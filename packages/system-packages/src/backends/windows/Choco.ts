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
 * `choco install <name> --version <version> -y` — Chocolatey's own
 * documented pin syntax (`choco install --help`, `choco -?`), unchanged
 * since this file's original verification pass. **UNVERIFIED here**: no
 * Windows target exists in this session either (the same limitation this
 * file's own `install`/`--local-only` flags already carry) — this is the
 * repo's existing documented-but-unrun convention for Windows
 * (`docs/TASKS.md`'s open `winget install` item), not new to this change.
 *
 * `--allow-downgrade` is Chocolatey's own documented flag for the direction
 * `--version` alone refuses (installing an older build over a newer one) —
 * added unconditionally alongside `--version` for the same reason `Apt.ts`
 * always adds `--allow-downgrades`: harmless when the requested version is
 * not actually older, necessary when it is. `canDowngrade: true` reflects
 * that flag's documented existence, not an independent confirmation that it
 * behaves as documented.
 */
export const chocoVersionSupport: PackageVersionSupport = {
  accepts: new Set(["Exact"]),
  canDowngrade: true,
};

const rejectSpec = rejectUnsupportedVersionSpec("choco", chocoVersionSupport);

/**
 * Chocolatey. Same PowerShell-quoting rationale as Winget.ts.
 *
 * `--limit-output` (`-r`) is Chocolatey's "give me machine-parseable output"
 * flag: one line per package as `name|version`, with no header or footer noise
 * — unlike winget, there is no fixed-width table to misparse here.
 *
 * Verified against Chocolatey 2.7.3 on a Windows runner, output kept as
 * `test/fixtures/choco-list.txt`: 45 lines, every one `name|version`, no
 * header, no footer, no count line. `--local-only` was accepted without error
 * or warning, which settles the open question about it — Chocolatey v2 made
 * `choco list` local-only by default and deprecated the flag, but it is taken
 * as a no-op rather than an error, so passing it explicitly stays safe across
 * versions.
 */
/** Declared here rather than inline at each `exec`, the same way this
 * backend's `versions` is: one statement of what this tool's own work costs. */
const chocoTimeouts: PackageTimeouts = {
  install: Timeouts.systemPackage,
  refresh: Timeouts.indexRefresh,
};

export const makeChocoBackend = (): PackageManagerBackend => ({
  id: "choco",
  executable: "choco",
  shell: "powershell",
  versions: chocoVersionSupport,
  timeouts: chocoTimeouts,
  list: (exec) =>
    exec({
      command: Sh.pwsh("choco", "list", "--local-only", "--limit-output"),
      shell: "powershell.exe",
    }).pipe(
      Effect.map((result) =>
        lines(result.stdout).map((line): PackageEntry => {
          const bar = line.indexOf("|");
          return bar === -1
            ? { name: line }
            : { name: line.slice(0, bar), version: line.slice(bar + 1) };
        }),
      ),
    ),
  install: (name, version, exec) =>
    UndefinedOr.match(version, {
      onUndefined: () =>
        exec({
          // `-y` / `--yes` skips the confirmation prompt Chocolatey shows by
          // default; widely documented but UNVERIFIED here.
          command: Sh.pwsh("choco", "install", name, "-y"),
          shell: "powershell.exe",
          timeout: chocoTimeouts.install,
        }).pipe(Effect.asVoid),
      onDefined: (spec) =>
        Match.value(spec).pipe(
          Match.tagsExhaustive({
            Exact: (v) =>
              exec({
                command: Sh.pwsh(
                  "choco",
                  "install",
                  name,
                  "--version",
                  v.version,
                  "--allow-downgrade",
                  "-y",
                ),
                shell: "powershell.exe",
                timeout: chocoTimeouts.install,
              }).pipe(Effect.asVoid),
            AtLeast: rejectSpec,
            Channel: rejectSpec,
            Digest: rejectSpec,
          }),
        ),
    }),
});
