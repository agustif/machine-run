import { expect, it } from "@effect/vitest";
import * as Fs from "node:fs";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { parseIcacls } from "../../src/windows/Icacls.ts";

/** Reads an env-configured fixture path, or `Option.none()` when unset — never `process.env` directly. */
const envPath = (name: string): Option.Option<string> =>
  Effect.runSync(Config.option(Config.string(name)));

/**
 * The same parser, run against `icacls` output captured moments earlier on
 * the machine running this test — the live half of the verification split
 * `AGENTS.md` §5 and `docs/MAP.md` §4 establish for every backend in this
 * repo (`windowsBackends.test.ts`/`windowsLive.test.ts` in `system-packages`
 * is the pattern this file copies).
 *
 * `Icacls.test.ts` pins behaviour against two real, but externally sourced,
 * fixtures. This is the other half: does this repo's own CI, on this repo's
 * own Windows runner, produce output this parser still handles. Skipped
 * everywhere else, because there is nothing to read — the CI step in
 * `.github/workflows/ci.yml`'s `verify-windows` job sets both variables to
 * files it just wrote.
 *
 * Until this job has run on a Windows runner and passed, the parser in
 * `Icacls.ts` is UNVERIFIED against this repo's own environment — see that
 * module's header comment. This file existing is not the same claim as this
 * file having passed.
 */
const listingFile = envPath("MACHINE_RUN_ICACLS_LISTING");
const listingPath = envPath("MACHINE_RUN_ICACLS_PATH");

it.skipIf(Option.isNone(listingFile) || Option.isNone(listingPath))(
  "`icacls <path>` still parses on this machine",
  () => {
    const stdout = Fs.readFileSync(Option.getOrElse(listingFile, () => ""), "utf8");
    // Unwrapped with `Result.getOrThrow` rather than a bare boolean
    // assertion, so a CI failure here says *what* about the format changed
    // instead of just that something did — the real `IcaclsParseError`
    // already carries that message.
    const result = Result.getOrThrow(parseIcacls(stdout, Option.getOrElse(listingPath, () => "")));

    // Shape-only, per the same rationale windowsLive.test.ts states: which
    // principals a runner image happens to carry is not a fact worth
    // pinning, but every real Windows object has *some* ACL.
    expect(result.aces.length).toBeGreaterThan(0);
    expect(result.aces.every((ace) => ace.principal.length > 0)).toBe(true);
    expect(result.aces.every((ace) => ace.rights.length > 0 || ace.inheritanceFlags.length > 0)).toBe(
      true,
    );
  },
);
