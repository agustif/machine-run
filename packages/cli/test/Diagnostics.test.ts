import { expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describeExit, withDeadline } from "../src/Diagnostics.ts";

/** A typed stand-in for "some command failed for a specific, known reason." */
class SomethingWentWrong extends Data.TaggedError("SomethingWentWrong")<{
  readonly reason: string;
}> {
  override get message() {
    return this.reason;
  }
}

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
  const exit = Exit.fail(new SomethingWentWrong({ reason: "something specific went wrong" }));
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

// `it.live` rather than `it.effect`: `withDeadline` waits on the real Clock
// through `Effect.timeout`, and `it.effect`'s virtual `TestClock` never
// advances on its own, which would make `Effect.never` indistinguishable from
// a deadline that never arrives — the exact ambiguity this function exists to
// resolve.
it.live("a program that never settles is reported as a hang, not left to exit silently", () =>
  Effect.gen(function* () {
    // This is the case ordinary error handling misses: a program that simply
    // never produces a value. `Effect.timeout` — not a raced external timer —
    // is what catches it; see `withDeadline`'s doc comment for why the
    // external-timer version this replaced was based on an untested theory
    // about the real defect, and what running that defect for real showed
    // instead.
    const exit = yield* Effect.exit(withDeadline(Effect.never, 50));

    expect(Exit.isFailure(exit)).toBe(true);
    const described = describeExit(exit, () => "unused");
    expect(described.code).not.toBe(0);
  }),
);

it.live("a normal program is unaffected by the deadline", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(withDeadline(Effect.succeed("done"), 60_000));
    expect(exit).toStrictEqual(Exit.succeed("done"));
  }),
);
