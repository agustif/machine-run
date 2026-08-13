import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import type { PackageManagerBackend } from "../../Backend.ts";
import { lines } from "../../parse.ts";

/**
 * Parses `winget list`'s human-readable table into package IDs.
 *
 * winget has no stable machine-readable listing output (no `--json`, no
 * `-r`/`--limit-output` the way choco has) — the table is fixed-width
 * columns (`Name  Id  Version  Available  Source`) separated by runs of
 * whitespace, with column widths that depend on the widest value winget
 * happened to print. This locates the header's dashed separator row so a
 * localized header string is never mistaken for data, then splits each data
 * row on runs of 2+ spaces and takes the second column (`Id`) — the first
 * (`Name`) is the human display name, not what `winget install --id`
 * expects.
 *
 * UNVERIFIED: this machine has no Windows/winget install to test against.
 * If a locale/console width wraps a cell onto a second line, or a `Name`
 * contains a run of 2+ spaces, this will misparse that row. `install` below
 * uses `--exact` specifically so an ID this misparsed into is never
 * fuzzy-matched into installing the wrong package.
 */
export const parseWingetList = (stdout: string): string[] => {
  const rows = lines(stdout);
  const separatorIndex = rows.findIndex((row) => /^-{3,}$/.test(row.replace(/\s/g, "")));
  if (separatorIndex === -1) return [];
  const ids: string[] = [];
  for (const row of rows.slice(separatorIndex + 1)) {
    const columns = row
      .split(/\s{2,}/)
      .map((column) => column.trim())
      .filter((column) => column.length > 0);
    const id = columns[1];
    if (id !== undefined) ids.push(id);
  }
  return ids;
};

/**
 * Windows Package Manager. Uses PowerShell quoting (`Sh.pwsh` + `shell:
 * "powershell.exe"`), NOT `Sh.sh`/`shell: true` — on Windows, Alchemy's
 * `shell: true` runs `cmd.exe`, whose quoting rules `Sh.quote` does not
 * implement (see the big comment in `@machine-run/core`'s `Sh.ts`).
 *
 * Flags below (`--exact`, `--accept-package-agreements`,
 * `--accept-source-agreements`, `--silent`, `--disable-interactivity`) are
 * the widely-documented ones for a non-interactive `winget install`, but are
 * UNVERIFIED on this machine (no Windows install available to test against).
 */
export const makeWingetBackend = (): PackageManagerBackend => ({
  id: "winget",
  list: (exec) =>
    exec({
      command: Sh.pwsh("winget", "list", "--accept-source-agreements"),
      shell: "powershell.exe",
    }).pipe(Effect.map((result) => parseWingetList(result.stdout))),
  install: (name, exec) =>
    exec({
      command: Sh.pwsh(
        "winget",
        "install",
        "--id",
        name,
        "--exact",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--silent",
        "--disable-interactivity",
      ),
      shell: "powershell.exe",
      timeout: "10 minutes",
    }).pipe(Effect.asVoid),
});
