import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

/**
 * How long a command may run before this reports a hang rather than waiting
 * forever.
 *
 * Generous, because a real plan shells out once per package resource and
 * `brew list` on a full machine is not fast. The point is not to police
 * duration; it is to make sure a *stuck* run produces a report instead of
 * looking like a slow one.
 */
export const DEFAULT_DEADLINE_MILLIS = 10 * 60_000;

/**
 * The program did not settle within its deadline.
 *
 * A tagged error rather than an inline shape so a caller can match it, and so
 * it reads the same way as every other failure in this repo.
 */
export class CommandTimedOut extends Data.TaggedError("CommandTimedOut")<{
  readonly afterMillis: number;
}> {
  override get message() {
    return `No result after ${this.afterMillis}ms. The engine can fail by never settling at all — see docs/V2-PLAN.md.`;
  }
}

/**
 * Renders an `Exit` as text, and says which exit code the process should carry.
 *
 * The reason this exists rather than letting failures propagate: `alchemy
 * plan` fails today by exiting 1 with empty stdout *and* empty stderr, even at
 * `--log-level all` — a `Die` defect that escapes its own error reporting
 * entirely. Diagnosing that took reading Effect's fiber internals by hand
 * because there was nothing printed to read. So every path here produces
 * text, and only a genuine success returns 0.
 */
export interface CommandOutcome {
  /** What to print. Never empty, including on failure — that is the point. */
  readonly text: string;
  /** Process exit code. Only a genuine success is 0. */
  readonly code: number;
}

export const describeExit = <A, E>(
  exit: Exit.Exit<A, E>,
  render: (value: A) => string,
): CommandOutcome => {
  if (Exit.isSuccess(exit)) return { text: render(exit.value), code: 0 };

  const pretty = Cause.pretty(exit.cause);
  const interrupted = Cause.hasInterruptsOnly(exit.cause);
  if (interrupted) {
    return { text: `Interrupted.\n\n${pretty}`, code: 130 };
  }
  return {
    text: [
      "This command failed.",
      "",
      pretty,
      "",
      "If the text above names a service that was not found, or reports",
      '"Not a valid effect: undefined", the fault is in the engine\'s own wiring',
      "rather than in your recipe — see docs/V2-PLAN.md, which records both",
      "shapes and how they were diagnosed.",
    ].join("\n"),
    code: 1,
  };
};

/**
 * Bounds `effect` to `deadlineMillis`, failing with {@link CommandTimedOut}
 * rather than running forever.
 *
 * This used to race a plain `setTimeout` outside Effect entirely, on the
 * theory that a defect thrown inside the fiber's own run loop could leave
 * `Effect.timeout` unable to observe it, because the timeout would live in
 * the same fiber that died. That theory was tested directly against the
 * defect it was written for — `alchemy plan`'s `Fiber.runLoop: Not a valid
 * effect: undefined` — reproduced for real via this package's own `Recipe`
 * and `Commands` modules, both with a synthetic defect (a concurrent
 * `Effect.forEach` mapper returning `undefined`, forced both synchronously and
 * from a genuine async callback resumption) and with the actual failing
 * recipe. In every case `Effect.timeout` wrapping the effect **in the same
 * fiber** observed the defect and settled within milliseconds; there was no
 * hang to catch.
 *
 * What *was* real: after that defect, the process did not exit on its own —
 * not because the timeout was blind, but because Alchemy's own concurrent
 * plan path leaves on the order of a thousand sibling fibers'/promises
 * un-settled (`async_hooks` confirmed this: ~1000 pending `PROMISE` resources
 * still alive seconds later), which keeps the Node event loop from draining
 * even though the correct `Exit` had already been produced. `Effect.timeout`
 * cannot fix that — nothing running inside the dying fiber's own tree can —
 * but forcing the process to exit once an `Exit` is in hand does, which is
 * exactly what `NodeRuntime.runMain`'s teardown does for any non-zero code.
 * That is `bin.ts`'s job now, not this function's.
 */
export const withDeadline = <A, E>(
  effect: Effect.Effect<A, E>,
  deadlineMillis: number,
): Effect.Effect<A, E | CommandTimedOut> =>
  effect.pipe(
    Effect.timeout(deadlineMillis),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(new CommandTimedOut({ afterMillis: deadlineMillis })),
    ),
  );
