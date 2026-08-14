import { expect, it } from "@effect/vitest";
import * as Fs from "node:fs";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { parseWingetList } from "../src/backends/windows/Winget.ts";
import { firstTokens, lines } from "../src/parse.ts";

/** Reads an env-configured fixture path, or `Option.none()` when unset — never `process.env` directly. */
const envPath = (name: string): Option.Option<string> =>
  Effect.runSync(Config.option(Config.string(name)));

/**
 * The same two parsers, run against output captured moments earlier on the
 * machine running this test.
 *
 * `windowsBackends.test.ts` pins behaviour against a fixture, which is what
 * catches a regression in the parser. This catches the other direction: winget
 * or Chocolatey changing its output format, which a frozen fixture can never
 * notice. CI's Windows verification job sets these two variables to files it
 * just wrote; everywhere else the tests skip, because there is nothing to read.
 *
 * Assertions here are about shape only. Which packages a runner image happens
 * to have installed is not a fact worth pinning.
 */
const wingetListFile = envPath("MACHINE_RUN_WINGET_LIST");
const chocoListFile = envPath("MACHINE_RUN_CHOCO_LIST");

it.skipIf(Option.isNone(wingetListFile))("`winget list` still parses on this machine", () => {
  const ids = parseWingetList(Fs.readFileSync(Option.getOrElse(wingetListFile, () => ""), "utf8"));

  // A Windows machine always has something installed, so an empty result means
  // the table stopped being found rather than that nothing is there.
  expect(ids.length).toBeGreaterThan(0);
  expect(ids.every((id) => !id.includes("…"))).toBe(true);
  expect(ids.every((id) => !/\s/.test(id))).toBe(true);
  expect(ids.some((id) => id.startsWith("ARP\\") || id.startsWith("MSIX\\"))).toBe(false);

  // Every winget id is `Publisher.Package`, sometimes with further dot-separated
  // parts. Anything without a dot means a column boundary moved.
  expect(ids.every((id) => id.includes("."))).toBe(true);
});

it.skipIf(Option.isNone(chocoListFile))("`choco list` still parses on this machine", () => {
  const names = firstTokens(
    lines(Fs.readFileSync(Option.getOrElse(chocoListFile, () => ""), "utf8")).map((line) =>
      line.split("|").join(" "),
    ),
  );

  expect(names.length).toBeGreaterThan(0);
  expect(names.every((name) => !name.includes("|"))).toBe(true);
  // `--limit-output` promises no header or footer, so no line may look like
  // prose or a count.
  expect(names.every((name) => !name.includes(" "))).toBe(true);
});
