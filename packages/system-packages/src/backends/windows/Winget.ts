import { Sh, Timeouts } from "@machine-run/core";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import * as UndefinedOr from "effect/UndefinedOr";
import {
  BackendParseError,
  type PackageEntry,
  type PackageManagerBackend,
  type PackageVersionSupport,
  rejectUnsupportedVersionSpec,
  type PackageTimeouts,
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
 * Parses the legacy `winget list` human-readable table into package IDs for
 * captured-output regression tests and diagnostics. Production reconciliation
 * uses {@link parseWingetExport} instead.
 *
 * The table is fixed-width columns (`Name  Id  Version  Available  Source`)
 * whose widths depend on the console width and on the widest value printed.
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
 * This parser remains exported for the captured-output regression test and for
 * diagnosing old runner transcripts. It is not the reconciler's production
 * listing path: `winget export` is the machine-readable path used below, so a
 * truncated table cell can no longer make an installed package look absent.
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
    entries.push(
      version.length === 0 || version.includes("…") ? { name: id } : { name: id, version },
    );
  }
  return entries;
};

/**
 * The JSON document written by `winget export`.
 *
 * The current schema nests package entries under `Sources`, because an export
 * can contain both the public Winget source and the Microsoft Store source.
 * Unknown fields are intentionally ignored: the CLI adds metadata such as
 * `CreationDate`, `WinGetVersion`, and source details that membership
 * reconciliation does not need.
 */
const WingetExport = Schema.fromJsonString(
  Schema.Struct({
    Sources: Schema.Array(
      Schema.Struct({
        Packages: Schema.Array(
          Schema.Struct({
            PackageIdentifier: Schema.String,
            Version: Schema.optionalKey(Schema.String),
          }),
        ),
      }),
    ),
  }),
);

const decodeWingetExport = Schema.decodeUnknownEffect(WingetExport);

/**
 * Decodes a real `winget export` document into the common package inventory.
 * Malformed JSON and schema drift are a typed parse failure at the CLI
 * boundary, never a guessed empty inventory.
 */
export const parseWingetExport = (
  content: string,
): Effect.Effect<PackageEntry[], BackendParseError> =>
  decodeWingetExport(content).pipe(
    Effect.map((document) =>
      document.Sources.flatMap((source) =>
        source.Packages.map((entry) =>
          entry.Version === undefined
            ? { name: entry.PackageIdentifier }
            : { name: entry.PackageIdentifier, version: entry.Version },
        ),
      ),
    ),
    Effect.catchTag("SchemaError", (cause) =>
      Effect.fail(new BackendParseError({ manager: "winget export", cause })),
    ),
  );

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
/** Declared here rather than inline at each `exec`, the same way this
 * backend's `versions` is: one statement of what this tool's own work costs. */
const wingetTimeouts: PackageTimeouts = {
  install: Timeouts.systemPackage,
  refresh: Timeouts.indexRefresh,
};

export const makeWingetBackend = (): PackageManagerBackend => ({
  id: "winget",
  executable: "winget",
  shell: "powershell",
  versions: wingetVersionSupport,
  timeouts: wingetTimeouts,
  list: (exec, context) => {
    if (context === undefined) {
      return Effect.fail(
        new BackendParseError({
          manager: "winget export",
          cause: "a PackageListContext is required to read winget export's file output",
        }),
      );
    }
    return context.withTemporaryFile((file) =>
      exec({
        command: Sh.pwsh(
          "winget",
          "export",
          "--output",
          file.path,
          "--include-versions",
          "--accept-source-agreements",
          "--disable-interactivity",
        ),
        shell: "powershell.exe",
        timeout: wingetTimeouts.refresh,
      }).pipe(
        Effect.flatMap(() => file.read),
        Effect.flatMap(parseWingetExport),
      ),
    );
  },
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
          timeout: wingetTimeouts.install,
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
                timeout: wingetTimeouts.install,
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
      timeout: wingetTimeouts.refresh,
    }).pipe(Effect.asVoid),
});
