import { expect, it } from "@effect/vitest";
import { CommandError, UnexpectedExit } from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Fs from "node:fs";
import * as Path from "node:path";
import {
  fromPosixMode,
  rightsForClass,
  toIcaclsArgv,
  toPosixMode,
  toWindowsAclPlan,
  WELL_KNOWN_PRINCIPALS,
} from "../../src/windows/FilePermissions.ts";
import { applyMode, readAcl } from "../../src/windows/Permissions.ts";

const icaclsFixture = Fs.readFileSync(
  Path.join(import.meta.dirname, "..", "fixtures", "icacls-c-drive.txt"),
  "utf8",
);

it("decomposes a POSIX mode into owner/group/other booleans", () => {
  expect(fromPosixMode(0o600, "file")).toEqual({
    target: "file",
    owner: { read: true, write: true, execute: false },
    group: { read: false, write: false, execute: false },
    other: { read: false, write: false, execute: false },
  });
  expect(fromPosixMode(0o750, "directory")).toEqual({
    target: "directory",
    owner: { read: true, write: true, execute: true },
    group: { read: true, write: false, execute: true },
    other: { read: false, write: false, execute: false },
  });
});

it("round-trips every POSIX mode through fromPosixMode/toPosixMode", () => {
  // The POSIX direction is lossless by construction — FilePermissions only
  // decomposes and recomposes the same nine bits, never approximates them.
  for (let mode = 0; mode <= 0o777; mode++) {
    expect(toPosixMode(fromPosixMode(mode, "file"))).toBe(mode);
  }
});

it("maps read to a bundle that includes RC and S, not just RD", () => {
  // Cited in the module doc comment: RC (read the ACL) and S (synchronize)
  // ride along with `read` rather than needing their own POSIX bit, since
  // POSIX has no bit for either concept.
  const rights = rightsForClass({ read: true, write: false, execute: false });
  expect(rights).toEqual(["RD", "REA", "RA", "RC", "S"]);
});

it("deduplicates rights shared across read and write bundles", () => {
  // Neither bundle actually overlaps today, but the dedup is what makes it
  // safe for that to change without a caller silently getting a right twice
  // in one icacls argument.
  const rights = rightsForClass({ read: true, write: true, execute: true });
  expect(new Set(rights).size).toBe(rights.length);
  expect(rights).toEqual(["RD", "REA", "RA", "RC", "S", "WD", "AD", "WEA", "WA", "X"]);
});

it("grants nothing to group or other for 0o600 (SecretFile's documented default)", () => {
  const plan = toWindowsAclPlan(fromPosixMode(0o600, "file"));
  expect(plan.resetInheritance).toBe(true);
  expect(plan.grants).toEqual([
    {
      principal: WELL_KNOWN_PRINCIPALS.owner,
      rights: ["RD", "REA", "RA", "RC", "S", "WD", "AD", "WEA", "WA"],
    },
  ]);
});

it("grants read to group and other for 0o644, matching a world-readable file's intent", () => {
  const plan = toWindowsAclPlan(fromPosixMode(0o644, "file"));
  expect(plan.grants.map((grant) => grant.principal)).toEqual([
    WELL_KNOWN_PRINCIPALS.owner,
    WELL_KNOWN_PRINCIPALS.group,
    WELL_KNOWN_PRINCIPALS.other,
  ]);
  expect(plan.grants[1]?.rights).toEqual(["RD", "REA", "RA", "RC", "S"]);
  expect(plan.grants[2]?.rights).toEqual(["RD", "REA", "RA", "RC", "S"]);
});

it("renders X for a 0o700 directory's owner bit, the one execute case that is genuinely faithful", () => {
  const plan = toWindowsAclPlan(fromPosixMode(0o700, "directory"));
  expect(plan.grants).toHaveLength(1);
  expect(plan.grants[0]?.rights).toContain("X");
});

it("omits a principal from the plan entirely when its class has no rights", () => {
  // 0o640: owner rw, group r, other nothing — `other` must not appear at all,
  // not appear with an empty right list.
  const plan = toWindowsAclPlan(fromPosixMode(0o640, "file"));
  expect(plan.grants.map((grant) => grant.principal)).toEqual([
    WELL_KNOWN_PRINCIPALS.owner,
    WELL_KNOWN_PRINCIPALS.group,
  ]);
});

it("uses the well-known SIDs cited in docs/notes/windows-permissions.md, not friendly names", () => {
  // Numeric so the command is language-independent — friendly names for
  // built-in identities only resolve on an English-language system.
  expect(WELL_KNOWN_PRINCIPALS.owner).toBe("*S-1-3-4");
  expect(WELL_KNOWN_PRINCIPALS.group).toBe("*S-1-5-32-545");
  expect(WELL_KNOWN_PRINCIPALS.other).toBe("*S-1-1-0");
});

it("renders a plan as plain icacls argv, resetting inheritance before granting", () => {
  const plan = toWindowsAclPlan(fromPosixMode(0o600, "file"));
  const argv = toIcaclsArgv("C:\\Users\\me\\.ssh\\id_ed25519", plan);
  expect(argv[0]).toBe("icacls");
  expect(argv[1]).toBe("C:\\Users\\me\\.ssh\\id_ed25519");
  expect(argv[2]).toBe("/inheritance:r");
  expect(argv[3]).toBe("/grant:r");
  expect(argv[4]).toBe("*S-1-3-4:(RD,REA,RA,RC,S,WD,AD,WEA,WA)");
  // Only one principal for 0o600 — no dangling "/grant:r" for group/other.
  expect(argv).toHaveLength(5);
});

it("renders no /grant:r tokens at all for 0o000 — every principal omitted", () => {
  const plan = toWindowsAclPlan(fromPosixMode(0o000, "file"));
  const argv = toIcaclsArgv("C:\\secret", plan);
  expect(argv).toEqual(["icacls", "C:\\secret", "/inheritance:r"]);
});

it.effect("applies Windows permissions through PowerShell, not cmd.exe", () =>
  Effect.gen(function* () {
    const calls: Array<{ readonly command: string; readonly shell: boolean | string }> = [];
    yield* applyMode(
      (props) => {
        calls.push(props);
        return Effect.succeed({ stdout: "" });
      },
      "C:\\Users\\me\\secret",
      0o600,
      "file",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.shell).toBe("powershell.exe");
    expect(calls[0]?.command).toContain("*S-1-3-4:(RD,REA,RA,RC,S,WD,AD,WEA,WA)");
  }),
);

it.effect("does not report success when icacls fails", () =>
  Effect.gen(function* () {
    const expected = new CommandError({
      command: "icacls",
      reason: new UnexpectedExit({ exitCode: 5, stderr: "Access is denied" }),
    });
    const failure = yield* applyMode(
      () => Effect.fail(expected),
      "C:\\Users\\me\\secret",
      0o600,
      "file",
    ).pipe(Effect.flip);

    expect(failure).toBe(expected);
  }),
);

it.effect("keeps command failure recoverable but rejects malformed successful output", () =>
  Effect.gen(function* () {
    const unavailable = yield* readAcl(
      () =>
        Effect.fail(
          new CommandError({
            command: "icacls",
            reason: new UnexpectedExit({ exitCode: 5, stderr: "Access is denied" }),
          }),
        ),
      "C:\\secret",
    );
    expect(Option.isNone(unavailable)).toBe(true);

    const malformed = yield* readAcl(
      () => Effect.succeed({ stdout: "not an icacls listing" }),
      "C:\\secret",
    ).pipe(Effect.flip);
    expect(malformed._tag).toBe("IcaclsParseError");

    const parsed = yield* readAcl(
      () => Effect.succeed({ stdout: icaclsFixture }),
      "C:\\",
    );
    expect(Option.isSome(parsed)).toBe(true);
  }),
);
