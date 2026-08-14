import { expect, it } from "@effect/vitest";
import * as Fs from "node:fs";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { WELL_KNOWN_PRINCIPAL_ALIASES } from "../../src/windows/FilePermissions.ts";
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

const sidRoundTripFile = envPath("MACHINE_RUN_ICACLS_SID_ROUNDTRIP");
const sidRoundTripPath = envPath("MACHINE_RUN_SID_PATH");

/**
 * The one assumption `WELL_KNOWN_PRINCIPAL_ALIASES` rests on, and the only one
 * that cannot be checked anywhere but Windows.
 *
 * Our ACL *writes* use numeric SID strings (`/grant *S-1-3-4:...`) because that
 * is what `icacls` accepts; a *read* prints friendly display names. If a SID does
 * not come back as the name the alias table expects, every comparison silently
 * fails to match and `matches` reports drift forever — the parser works, the
 * plumbing works, and the resource never converges. Only `BUILTIN\Users` was
 * independently confirmed before this, by two captured fixtures.
 *
 * The CI step grants with each SID form we emit, then reads the listing back.
 * This asserts that every principal in that listing is one the alias table knows
 * — which is the property `aclSatisfiesMode` actually depends on, rather than
 * asserting a specific spelling that could vary by locale.
 */
it.skipIf(Option.isNone(sidRoundTripFile) || Option.isNone(sidRoundTripPath))(
  "every principal our own SID grants read back as is one the alias table knows",
  () => {
    const stdout = Fs.readFileSync(Option.getOrThrow(sidRoundTripFile), "utf8");
    const listing = Result.getOrThrow(
      parseIcacls(stdout, Option.getOrThrow(sidRoundTripPath)),
    );

    const known = new Set(Object.values(WELL_KNOWN_PRINCIPAL_ALIASES).flat());
    const unrecognised = listing.aces
      .map((ace) => ace.principal)
      .filter((principal) => !known.has(principal));

    // Reported with the whole listing, because a bare "unrecognised principal"
    // failure gives whoever reads it nothing to add to the alias table.
    expect(unrecognised, `unrecognised principals in:\n${stdout}`).toEqual([]);
  },
);
