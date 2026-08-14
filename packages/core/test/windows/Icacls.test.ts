import { expect, it } from "@effect/vitest";
import * as Fs from "node:fs";
import * as Path from "node:path";
import * as Result from "effect/Result";
import { fromPosixMode } from "../../src/windows/FilePermissions.ts";
import {
  grantedRights,
  isNoBroaderThan,
  matchesMode,
  parseIcacls,
  permissionsSatisfied,
  type IcaclsListing,
} from "../../src/windows/Icacls.ts";

/**
 * Both fixtures are real `icacls` output, captured on a real Windows machine
 * and posted publicly rather than invented — see
 * docs/notes/windows-permissions.md §5 for the exact source and how these two
 * blocks were sliced out of the fuller transcript (only the interactive
 * shell's `PS ...> icacls ...` prompt-echo lines were stripped; nothing about
 * `icacls`'s own output was altered).
 */
const fixture = (name: string): string =>
  Fs.readFileSync(Path.join(import.meta.dirname, "..", "fixtures", name), "utf8");

it("parses a root drive's ACL: multiple ACEs per principal, and a Mandatory Label entry", () => {
  const result = parseIcacls(fixture("icacls-c-drive.txt"), "C:\\");
  expect(Result.isSuccess(result)).toBe(true);
  if (!Result.isSuccess(result)) return;

  expect(result.success.path).toBe("C:\\");
  expect(result.success.aces).toEqual([
    {
      principal: "BUILTIN\\Administrators",
      inherited: false,
      inheritanceFlags: ["OI", "CI"],
      rights: ["F"],
    },
    {
      principal: "NT AUTHORITY\\SYSTEM",
      inherited: false,
      inheritanceFlags: ["OI", "CI"],
      rights: ["F"],
    },
    {
      principal: "BUILTIN\\Users",
      inherited: false,
      inheritanceFlags: ["OI", "CI"],
      rights: ["RX"],
    },
    {
      principal: "NT AUTHORITY\\Authenticated Users",
      inherited: false,
      inheritanceFlags: ["OI", "CI", "IO"],
      rights: ["M"],
    },
    {
      principal: "NT AUTHORITY\\Authenticated Users",
      inherited: false,
      inheritanceFlags: [],
      rights: ["AD"],
    },
    // Not a DACL grant at all — this is the SACL integrity-label entry
    // `icacls` prints inline with the DACL. `NW` ("No Write Up") is not in
    // FilePermissions.ts's IcaclsRight set and is not expected to be: this
    // parser passes through whatever token is there rather than rejecting a
    // line it does not recognise. See this module's header comment.
    {
      principal: "Mandatory Label\\High Mandatory Level",
      inherited: false,
      inheritanceFlags: ["OI", "NP", "IO"],
      rights: ["NW"],
    },
  ]);
});

it("marks (I) as inherited, distinct from the (OI)(CI) propagation flags", () => {
  const result = parseIcacls(fixture("icacls-appdata.txt"), "C:\\Users\\user\\AppData\\");
  expect(Result.isSuccess(result)).toBe(true);
  if (!Result.isSuccess(result)) return;

  for (const ace of result.success.aces) {
    expect(ace.inherited).toBe(true);
    expect(ace.inheritanceFlags).toEqual(["I", "OI", "CI"]);
    expect(ace.rights).toEqual(["F"]);
  }
  expect(result.success.aces.map((ace) => ace.principal)).toEqual([
    "NT AUTHORITY\\SYSTEM",
    "BUILTIN\\Administrators",
    "LOCATION\\user",
  ]);
});

it("unions rights across every ACE naming the same principal", () => {
  const result = parseIcacls(fixture("icacls-c-drive.txt"), "C:\\");
  expect(Result.isSuccess(result)).toBe(true);
  if (!Result.isSuccess(result)) return;

  // "NT AUTHORITY\Authenticated Users" is granted (M) on one ACE and (AD) on
  // another — a caller asking "what can this principal do here" wants both.
  const rights = grantedRights(result.success, "NT AUTHORITY\\Authenticated Users");
  expect(rights).toEqual(new Set(["M", "AD"]));
});

it("fails loudly, rather than guessing, when the requested path isn't the line's prefix", () => {
  const result = parseIcacls(fixture("icacls-c-drive.txt"), "D:\\");
  expect(Result.isFailure(result)).toBe(true);
});

it('fails loudly on a line that isn\'t "<principal>:(<rights>)"', () => {
  // Deliberately synthetic — this asserts the error path, not a claim about
  // real icacls output (which the two fixtures above already pin).
  const stdout =
    "C:\\weird not-an-ace-line at all\n\nSuccessfully processed 1 files; Failed processing 0 files\n";
  const result = parseIcacls(stdout, "C:\\weird");
  expect(Result.isFailure(result)).toBe(true);
});

it("fails loudly when icacls itself reports a failed file", () => {
  const stdout =
    "C:\\gone BUILTIN\\Users:(F)\n\nSuccessfully processed 0 files; Failed processing 1 files\n";
  const result = parseIcacls(stdout, "C:\\gone");
  expect(Result.isFailure(result)).toBe(true);
});

it("isNoBroaderThan: a subset of allowed rights matches, an extra right does not", () => {
  expect(isNoBroaderThan(new Set(["RD", "RC"]), ["RD", "RC", "S"])).toBe(true);
  expect(isNoBroaderThan(new Set(["RD", "WD"]), ["RD", "RC", "S"])).toBe(false);
  expect(isNoBroaderThan(new Set(), ["RD", "RC", "S"])).toBe(true);
});

/** A listing shaped exactly like what `toIcaclsArgv(path, toWindowsAclPlan(fromPosixMode(0o600, "file")))`
 * asked for, then read back — the owner's alias resolved to its friendly
 * display name, per `WELL_KNOWN_PRINCIPAL_ALIASES`'s documented UNVERIFIED
 * assumption about what a plain listing prints back. */
const listingFor0o600: IcaclsListing = {
  path: "C:\\secret",
  aces: [
    {
      principal: "OWNER RIGHTS",
      inherited: false,
      inheritanceFlags: [],
      rights: ["RD", "REA", "RA", "RC", "S", "WD", "AD", "WEA", "WA"],
    },
  ],
};

it("permissionsSatisfied: true for a listing that grants exactly a 0o600 owner-only intent", () => {
  expect(permissionsSatisfied(listingFor0o600, fromPosixMode(0o600, "file"))).toBe(true);
});

it("permissionsSatisfied: false when Everyone gained a right 0o600 withholds", () => {
  const drifted: IcaclsListing = {
    ...listingFor0o600,
    aces: [
      ...listingFor0o600.aces,
      { principal: "Everyone", inherited: false, inheritanceFlags: [], rights: ["RD"] },
    ],
  };
  expect(permissionsSatisfied(drifted, fromPosixMode(0o600, "file"))).toBe(false);
});

it("permissionsSatisfied: accepts the numeric SID form as well as the friendly name", () => {
  const listing: IcaclsListing = {
    path: "C:\\secret",
    aces: [{ principal: "*S-1-3-4", inherited: false, inheritanceFlags: [], rights: ["RD"] }],
  };
  // A listing granting less than 0o600's full owner bundle still satisfies —
  // the documented asymmetry (isNoBroaderThan's doc comment): this cannot
  // detect a principal that lost rights `mode` promised.
  expect(permissionsSatisfied(listing, fromPosixMode(0o600, "file"))).toBe(true);
});

it("permissionsSatisfied: BUILTIN\\Users granted read for 0o644 satisfies, granted write does not", () => {
  const readOnly: IcaclsListing = {
    path: "C:\\shared",
    aces: [
      {
        principal: "OWNER RIGHTS",
        inherited: false,
        inheritanceFlags: [],
        rights: ["RD", "REA", "RA", "RC", "S", "WD", "AD", "WEA", "WA"],
      },
      { principal: "BUILTIN\\Users", inherited: false, inheritanceFlags: [], rights: ["RD", "RC"] },
      { principal: "Everyone", inherited: false, inheritanceFlags: [], rights: ["RD", "RC"] },
    ],
  };
  expect(permissionsSatisfied(readOnly, fromPosixMode(0o644, "file"))).toBe(true);

  const writable: IcaclsListing = {
    ...readOnly,
    aces: [
      ...readOnly.aces,
      { principal: "BUILTIN\\Users", inherited: false, inheritanceFlags: [], rights: ["WD"] },
    ],
  };
  expect(permissionsSatisfied(writable, fromPosixMode(0o644, "file"))).toBe(false);
});

it("matchesMode: composes parseIcacls and permissionsSatisfied for a matching 0o600 ACL", () => {
  const stdout =
    "C:\\secret OWNER RIGHTS:(RD,REA,RA,RC,S,WD,AD,WEA,WA)\n\nSuccessfully processed 1 files; Failed processing 0 files\n";
  const result = matchesMode(stdout, "C:\\secret", 0o600, "file");
  expect(result).toEqual(Result.succeed(true));
});

it("matchesMode: resolves to a real (non-error) `false` when the live ACL is broader than mode", () => {
  const stdout =
    "C:\\secret OWNER RIGHTS:(RD,REA,RA,RC,S,WD,AD,WEA,WA)\n" +
    "           Everyone:(RD)\n\n" +
    "Successfully processed 1 files; Failed processing 0 files\n";
  const result = matchesMode(stdout, "C:\\secret", 0o600, "file");
  expect(result).toEqual(Result.succeed(false));
});

it("matchesMode: fails (does not silently report false) when stdout cannot be parsed", () => {
  const result = matchesMode("nonsense", "C:\\secret", 0o600, "file");
  expect(Result.isFailure(result)).toBe(true);
});
