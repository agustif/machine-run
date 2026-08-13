import { expect, it } from "@effect/vitest";
import { CommandError, UnexpectedExit } from "alchemy/Command";
import { BadArgument } from "effect/PlatformError";
import { isExitCode, stderrOf } from "../src/exitCode.ts";

const unexpectedExit = (exitCode: number, stderr = "") =>
  new CommandError({ command: "irrelevant", reason: new UnexpectedExit({ exitCode, stderr }) });

it("isExitCode matches only the real exit code of an UnexpectedExit", () => {
  expect(isExitCode(unexpectedExit(1), 1)).toBe(true);
  expect(isExitCode(unexpectedExit(1), 5)).toBe(false);
});

it("isExitCode is false for a failure that never produced an exit code", () => {
  const spawnFailure = new CommandError({
    command: "irrelevant",
    reason: new BadArgument({ module: "Command", method: "run", description: "bad" }),
  });
  expect(isExitCode(spawnFailure, 1)).toBe(false);
});

it("stderrOf reads the UnexpectedExit's stderr, and is empty for any other failure shape", () => {
  expect(stderrOf(unexpectedExit(128, "fatal: boom"))).toBe("fatal: boom");
  const spawnFailure = new CommandError({
    command: "irrelevant",
    reason: new BadArgument({ module: "Command", method: "run", description: "bad" }),
  });
  expect(stderrOf(spawnFailure)).toBe("");
});
