import { expect, it } from "@effect/vitest";
import * as Fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseWingetList } from "../src/backends/windows/Winget.ts";
import { firstTokens, lines } from "../src/parse.ts";

/**
 * The winget and choco parsers against output captured from a real Windows
 * runner, not from documentation.
 *
 * Both fixtures came out of CI's `verify winget / choco parsers` job. They are
 * the reason these two backends no longer carry an UNVERIFIED note, and the
 * winget one is the reason its parser was rewritten: the shape documentation
 * describes and the shape winget prints differ in a way that silently corrupted
 * a seventh of the rows.
 */
const fixture = (name: string): string =>
  Fs.readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

it("parses real `winget list` output, dropping ids winget did not print in full", () => {
  const entries = parseWingetList(fixture("winget-list.txt"));
  const ids = entries.map((entry) => entry.name);

  expect(ids).toContain("7zip.7zip");
  expect(ids).toContain("Git.Git");
  expect(ids).toContain("Microsoft.PowerShell");
  expect(ids).toContain("Microsoft.WindowsTerminal");

  // An id winget truncated to fit its column is not recoverable, so it must not
  // appear in any form — least of all a partial one that could match something.
  expect(ids.every((id) => !id.includes("…"))).toBe(true);

  // Add/Remove-Programs and MSIX entries have no winget package behind them, so
  // `winget install --id` cannot act on them.
  expect(ids.some((id) => id.startsWith("ARP\\") || id.startsWith("MSIX\\"))).toBe(false);

  // The bug this fixture caught: winget's ellipsis eats the column padding, so
  // an over-long id is followed by a single space rather than the usual run.
  // Splitting on 2+ spaces therefore returned the id and version glued
  // together. No surviving id may contain whitespace at all.
  expect(ids.every((id) => !/\s/.test(id))).toBe(true);

  // Every surviving row's `Version` column was sliced the same way `Id` was —
  // no entry should have an empty or ellipsis-truncated version.
  expect(entries.every((entry) => entry.version === undefined || entry.version.length > 0)).toBe(
    true,
  );
  expect(entries.every((entry) => !(entry.version ?? "").includes("…"))).toBe(true);
});

it("keeps an id containing a single space, which fixed-width columns preserve", () => {
  // `Mozilla Firefox` is an ARP entry and so dropped, but the header-offset
  // slicing is what makes a space-bearing id parse as one cell in the first
  // place — a synthetic row proves that independently of the drop rules.
  const table = [
    "Name                 Id                   Version",
    "--------------------------------------------------",
    "Some Display Name    Vendor.Some Product  1.2.3",
  ].join("\n");
  expect(parseWingetList(table)).toEqual([{ name: "Vendor.Some Product", version: "1.2.3" }]);
});

it("returns nothing rather than guessing when there is no table at all", () => {
  // winget prints source-agreement prose and progress bars before the table,
  // and prints only prose when `--accept-source-agreements` is missing.
  expect(parseWingetList("")).toEqual([]);
  expect(parseWingetList("One or more of the source agreements were not agreed to.")).toEqual([]);
});

it("parses real `choco list --limit-output` output as name|version", () => {
  const names = firstTokens(
    lines(fixture("choco-list.txt")).map((line) => line.split("|").join(" ")),
  );

  expect(names).toContain("7zip.install");
  expect(names).toContain("wixtoolset");
  expect(names).toContain("nuget.commandline");

  // `--limit-output` emits no header, no footer and no count line, so every
  // line is a package and nothing needs skipping.
  expect(names).toHaveLength(45);

  // A version must never survive into a package name.
  expect(names.every((name) => !name.includes("|") && !/^\d+\./.test(name))).toBe(true);
});
