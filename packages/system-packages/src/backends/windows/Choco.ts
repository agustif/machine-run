import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import type { PackageManagerBackend } from "../../Backend.ts";
import { firstTokens, lines } from "../../parse.ts";

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
export const makeChocoBackend = (): PackageManagerBackend => ({
  id: "choco",
  list: (exec) =>
    exec({
      command: Sh.pwsh("choco", "list", "--local-only", "--limit-output"),
      shell: "powershell.exe",
    }).pipe(
      Effect.map((result) =>
        // Each line is "name|version" — split on "|" and take the name,
        // never the raw first whitespace-token (a display name could
        // contain spaces).
        firstTokens(lines(result.stdout).map((line) => line.split("|").join(" "))),
      ),
    ),
  install: (name, exec) =>
    exec({
      // `-y` / `--yes` skips the confirmation prompt Chocolatey shows by
      // default; widely documented but UNVERIFIED here.
      command: Sh.pwsh("choco", "install", name, "-y"),
      shell: "powershell.exe",
      timeout: "10 minutes",
    }).pipe(Effect.asVoid),
});
