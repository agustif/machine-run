import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describeExit, runToExit } from "../src/Diagnostics.ts";

/**
 * The behaviour this package exists for.
 *
 * `alchemy plan` fails by exiting 1 with empty stdout *and* empty stderr, even
 * at `--log-level all`. That is worse than a crash: there is nothing to read,
 * so the only way to learn anything is to run the CLI's own effect by hand and
 * inspect the `Exit`. These tests pin the two properties that prevent this
 * command from ever behaving that way.
 */
it("a failure always produces text and a non-zero code", () => {
  const exit = Exit.fail(new Error("something specific went wrong"));
  const described = describeExit(exit, () => "unused");

  expect(described.code).not.toBe(0);
  expect(described.text.length).toBeGreaterThan(0);
  expect(described.text).toContain("something specific went wrong");
});

it("a defect is reported rather than swallowed", () => {
  // The engine's own failure mode: a Die defect, not a typed error. Reporting
  // only typed failures would reproduce exactly the silence being fixed.
  const exit = Exit.die(new Error("Fiber.runLoop: Not a valid effect: undefined"));
  const described = describeExit(exit, () => "unused");

  expect(described.code).toBe(1);
  expect(described.text).toContain("Not a valid effect: undefined");
});

it("success renders the value and exits zero", () => {
  const described = describeExit(Exit.succeed(["one", "two"]), (lines) => lines.join("\n"));
  expect(described).toEqual({ text: "one\ntwo", code: 0 });
});

it("a program that never settles is reported as a hang, not left to exit silently", async () => {
  // This is the case ordinary error handling misses. A fiber that dies inside
  // the run loop can leave its promise unsettled; the event loop then drains
  // and Node exits 0 having printed nothing — a total failure that looks like
  // success. `Effect.timeout` cannot be relied on to catch it, because the
  // timeout lives inside the same fiber that died, so the race is run outside
  // Effect against a plain timer.
  const exit = await runToExit(Effect.never, 50);

  expect(Exit.isFailure(exit)).toBe(true);
  const described = describeExit(exit, () => "unused");
  expect(described.code).not.toBe(0);
});

it("a normal program is unaffected by the deadline", async () => {
  const exit = await runToExit(Effect.succeed("done"), 60_000);
  expect(exit).toStrictEqual(Exit.succeed("done"));
});
