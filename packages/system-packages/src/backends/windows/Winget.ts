import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as UndefinedOr from "effect/UndefinedOr";
import {
  type PackageEntry,
  type PackageManagerBackend,
  type PackageVersionSupport,
  rejectUnsupportedVersionSpec,
} from "../../Backend.ts";
import { lines } from "../../parse.ts";

/**
 * `winget install --id <id> --version <version> --exact ...` — winget's own
 * documented pin syntax (`winget install --help`). **UNVERIFIED here**: no
 * Windows target exists in this session, the same limitation every other
 * flag in this file already carries (see the module doc comment below).
 *
 * `--force` is added unconditionally alongside `--version`: winget is
 * documented to refuse a plain `install` when the id is already present
 * (its ordinary path for changing an installed version is `winget upgrade`,
 * not `install`), the same shape `Pipx.ts` confirmed for real this session
 * (a bare re-`install` silently no-ops rather than changing the pinned
 * version). `--force` is winget's own documented escape from that refusal;
 * not independently confirmed against a real `winget` binary, so
 * `canDowngrade: true` reflects the flag's documented existence, not a
 * verified behaviour.
 */
export const wingetVersionSupport: PackageVersionSupport = {
  accepts: new Set(["Exact"]),
  canDowngrade: true,
};

const rejectSpec = rejectUnsupportedVersionSpec("winget", wingetVersionSupport);

/**
 * Parses `winget list`'s human-readable table into package IDs.
 *
 * winget has no machine-readable listing output — no `--json`, and no
 * `-r`/`--limit-output` the way choco has. The table is fixed-width columns
 * (`Name  Id  Version  Available  Source`) whose widths depend on the console
 * width and on the widest value printed.
 *
 * Verified against real `winget list` output from a Windows runner, kept as
 * `test/fixtures/winget-list.txt`. That output is why this slices by column
 * offset rather than splitting on runs of whitespace, which is what it used to
 * do: **winget truncates an over-long cell with an ellipsis that consumes the
 * column's padding**, leaving a single space before the next column. Splitting
 * on 2+ spaces then merges `Id` and `Version` into one string — 9 of the
 * fixture's 64 rows produced a value like
 * `ARP\Machine\X64\MozillaMaintenanceServi… 153.0.1`, and 6 more produced no
 * id at all.
 *
 * Column boundaries come from whitespace runs in the header row rather than
 * from the labels, so a localized winget still parses.
 *
 * Two kinds of row are dropped, both deliberately:
 *
 * - **Truncated ids** (containing `…`). The full id is simply not present in
 *   the output, and a truncated one is worse than a missing one: it cannot
 *   match a desired package, and it could in principle match the wrong thing.
 * - **`ARP\…` and `MSIX\…` pseudo-ids** (10 of the fixture's rows). These name
 *   Add/Remove-Programs and MSIX entries with no winget package behind them, so
 *   `winget install --id` cannot act on them. They are noise for a reconciler.
 *
 * The consequence to know about: a package whose id is truncated reads as *not
 * installed*, so `apply` will run `winget install` for it on every deploy.
 * winget itself is idempotent, so nothing breaks, but the plan is not empty.
 * The real fix is `winget export`, which emits JSON with untruncated
 * identifiers — see docs/TASKS.md.
 *
 * The `Version` column (immediately right of `Id` in the same fixture) is
 * read the identical way — sliced by the next column's start offset, dropped
 * if it contains the same truncating ellipsis. A row whose `Id` survives but
 * whose `Version` is truncated still reports `{ name }` with no `version`
 * rather than being dropped outright: the id alone is enough for membership,
 * and an absent version is the same "can't compare" signal `PackageEntry`
 * already uses elsewhere, not a reason to also lose the id.
 */
export const parseWingetList = (stdout: string): PackageEntry[] => {
  const rows = lines(stdout);
  const separatorIndex = rows.findIndex((row) => /^-{3,}$/.test(row.replace(/\s/g, "")));
  const header = separatorIndex > 0 ? rows[separatorIndex - 1] : undefined;
  if (separatorIndex === -1 || header === undefined) return [];

  // Start offset of every column, taken from where the header's labels begin.
  const starts = [...header.matchAll(/(?:^|\s{2,})(\S)/g)].map(
    (match) => match.index + match[0].length - 1,
  );
  const idStart = starts[1];
  const idEnd = starts[2];
  const versionEnd = starts[3];
  if (idStart === undefined || idEnd === undefined) return [];

  const entries: PackageEntry[] = [];
  for (const row of rows.slice(separatorIndex + 1)) {
    const id = row.slice(idStart, idEnd).trim();
    if (id.length === 0 || id.includes("…") || /^(?:ARP|MSIX)\\/.test(id)) continue;
    const rawVersion = versionEnd === undefined ? row.slice(idEnd) : row.slice(idEnd, versionEnd);
    const version = rawVersion.trim();
    entries.push(version.length === 0 || version.includes("…") ? { name: id } : { name: id, version });
  }
  return entries;
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
  versions: wingetVersionSupport,
  list: (exec) =>
    exec({
      command: Sh.pwsh("winget", "list", "--accept-source-agreements"),
      shell: "powershell.exe",
    }).pipe(Effect.map((result) => parseWingetList(result.stdout))),
  install: (name, version, exec) =>
    UndefinedOr.match(version, {
      onUndefined: () =>
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
      onDefined: (spec) =>
        Match.value(spec).pipe(
          Match.tagsExhaustive({
            Exact: (v) =>
              exec({
                command: Sh.pwsh(
                  "winget",
                  "install",
                  "--id",
                  name,
                  "--version",
                  v.version,
                  "--exact",
                  "--force",
                  "--accept-package-agreements",
                  "--accept-source-agreements",
                  "--silent",
                  "--disable-interactivity",
                ),
                shell: "powershell.exe",
                timeout: "10 minutes",
              }).pipe(Effect.asVoid),
            AtLeast: rejectSpec,
            Channel: rejectSpec,
            Digest: rejectSpec,
          }),
        ),
    }),
  // `winget source update` — refreshes the local cache of each configured
  // source (winget, msstore); documented (`winget source update --help`) as
  // the fix for a stale source giving "No package found" against packages
  // that do exist. UNVERIFIED here — no Windows target this session, same
  // caveat as every other winget flag in this file.
  refreshIndex: (exec) =>
    exec({
      command: Sh.pwsh("winget", "source", "update"),
      shell: "powershell.exe",
      timeout: "5 minutes",
    }).pipe(Effect.asVoid),
});
