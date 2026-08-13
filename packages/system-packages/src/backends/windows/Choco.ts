import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import type { PackageManagerBackend } from "../../Backend.ts";
import { firstTokens, lines } from "../../parse.ts";

/**
 * Chocolatey. Same PowerShell-quoting rationale as Winget.ts.
 *
 * `--limit-output` (`-r`) is Chocolatey's long-documented "give me
 * machine-parseable output" flag: one line per package as `name|version`,
 * with no header/footer noise — unlike winget, there's no fixed-width table
 * to misparse here. `--local-only` restricts to installed packages (older
 * docs; some Chocolatey v2 builds made `choco list` local-only by default
 * and deprecated the flag, but it is accepted as a no-op there rather than
 * an error, so passing it explicitly is safe across versions AS FAR AS THE
 * DOCUMENTATION DESCRIBES — UNVERIFIED on this machine, no Windows/choco
 * install available to test against).
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
