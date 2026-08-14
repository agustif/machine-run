import { expect, it } from "@effect/vitest";
import { spawnSync } from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import * as Schema from "effect/Schema";
import { renderGhAccountSwitchCommand } from "../src/Identity.ts";

const quoteAsShellString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

// --- renderGhAccountSwitchCommand: shape ---

it("renders a plain ghAccount unquoted, since it needs no protection", () => {
  expect(renderGhAccountSwitchCommand("agustif")).toBe(
    "gh auth switch --user agustif >/dev/null 2>&1",
  );
});

it("single-quotes a ghAccount carrying shell metacharacters", () => {
  expect(renderGhAccountSwitchCommand("victim; touch pwned")).toBe(
    "gh auth switch --user 'victim; touch pwned' >/dev/null 2>&1",
  );
});

// --- renderGhAccountSwitchCommand: real shell parsing ---
//
// The string-shape assertions above pin the output, but the bug this guards
// against (0.6 in MUST_CLEANUP.md) is about how a real `/bin/sh` parses that
// output, not about the string's characters in isolation. So this actually
// hands the rendered command to `/bin/sh -c` and observes what ran — with
// `gh` on `PATH` replaced by a harmless stub that only records its argv,
// never a real `gh auth switch` (which would mutate the operator's actual
// gh CLI state).

/** A stub `gh` that logs the argv it was invoked with, one per line, to `logPath`. */
const installGhStub = (binDir: string, logPath: string) => {
  const stubPath = Path.join(binDir, "gh");
  Fs.writeFileSync(stubPath, `#!/bin/sh\nprintf '%s\\n' "$@" > ${quoteAsShellString(logPath)}\n`);
  Fs.chmodSync(stubPath, 0o755);
};

/**
 * Runs `command` through a real POSIX shell, with the stub `gh` shadowing any
 * real one.
 *
 * `spawnSync` rather than `execFileSync`: it reports a non-zero exit via its
 * return value instead of throwing, and this test does not care whether the
 * stub-driven `gh` "succeeds" — only whether a second, injected command got
 * to run at all.
 */
const runThroughRealShell = (command: string, binDir: string, cwd: string) => {
  // The whole point of this test is a real `/bin/sh` finding a stub `gh` on
  // `PATH` ahead of the real one — inheriting the actual process environment
  // and prepending to its actual `PATH` is the mechanism, not a convenience.
  // oxlint-disable-next-line effect/noGlobals -- process boundary: spawning a real shell for real, not through Effect's platform.
  const env = { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` };
  spawnSync("/bin/sh", ["-c", command], { cwd, env });
};

it("keeps a metacharacter-laden ghAccount inert against a real shell: gh sees it as one argument, and no injected command runs", () => {
  const tmp = Fs.mkdtempSync(Path.join(Os.tmpdir(), "gh-identity-test-"));
  const binDir = Path.join(tmp, "bin");
  Fs.mkdirSync(binDir);
  const logPath = Path.join(tmp, "gh.log");
  const injectedMarker = Path.join(tmp, "INJECTED");
  installGhStub(binDir, logPath);

  const malicious = `victim; touch ${injectedMarker}`;
  runThroughRealShell(renderGhAccountSwitchCommand(malicious), binDir, tmp);

  // The stub `gh` was invoked at all, and with the whole malicious string as
  // a single `--user` argument rather than losing everything after the `;`.
  const loggedArgs = Fs.readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  expect(loggedArgs).toEqual(["auth", "switch", "--user", malicious]);

  // The part after `;` never ran as its own command.
  expect(Fs.existsSync(injectedMarker)).toBe(false);
});

it("regression guard: the same payload against the pre-fix, unquoted interpolation *does* break out into a second command", () => {
  // This is the exact shape `Identity.ts` used before the fix (MUST_CLEANUP.md
  // 0.6) — reproduced locally, never imported, so this test would fail loudly
  // if `renderGhAccountSwitchCommand` regressed back to raw interpolation and
  // someone "simplified" this file to match it.
  const preFixCommand = (ghAccount: string) => `gh auth switch --user ${ghAccount} >/dev/null 2>&1`;

  const tmp = Fs.mkdtempSync(Path.join(Os.tmpdir(), "gh-identity-test-vuln-"));
  const binDir = Path.join(tmp, "bin");
  Fs.mkdirSync(binDir);
  const logPath = Path.join(tmp, "gh.log");
  const injectedMarker = Path.join(tmp, "INJECTED");
  installGhStub(binDir, logPath);

  const malicious = `victim; touch ${injectedMarker}`;
  runThroughRealShell(preFixCommand(malicious), binDir, tmp);

  // Proof this test harness can actually catch the bug: the unquoted version
  // lets `; touch ...` run as an independent command.
  expect(Fs.existsSync(injectedMarker)).toBe(true);
});
