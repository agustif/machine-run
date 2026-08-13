import * as Cause from "effect/Cause";
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
 * Renders an `Exit` as text, and says which exit code the process should carry.
 *
 * The reason this exists rather than letting failures propagate: a `Die` defect
 * escaping a fiber can leave the promise driving it unsettled. The event loop
 * then drains, and **Node exits 0 having printed nothing** — a total failure
 * that looks like a clean success. That is not a hypothetical; it is exactly
 * what `alchemy plan` does today, and diagnosing it took reading Effect's fiber
 * internals because there was no output to read.
 *
 * So every path here produces text, and only a genuine success returns 0.
 */
export interface CommandOutcome {
  /** What to print. Never empty, including on failure — that is the point. */
  readonly text: string;
  /** Process exit code. Only a genuine success is 0. */
  readonly code: number;
}

export const describeExit = <A>(
  exit: Exit.Exit<A, unknown>,
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
 * Runs `effect` to an `Exit` that is always produced, even when the underlying
 * fiber would otherwise never settle.
 *
 * `Effect.timeout` alone is not enough: a defect thrown inside the fiber's run
 * loop can prevent the timeout from ever being observed. So the race is done
 * outside Effect, against a plain timer, and a lost race is reported as a hang
 * with the deadline named.
 */
export const runToExit = <A, E>(
  effect: Effect.Effect<A, E, never>,
  deadlineMillis: number,
): Promise<Exit.Exit<A, E | { readonly _tag: "Timeout"; readonly afterMillis: number }>> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Exit.Exit<never, { _tag: "Timeout"; afterMillis: number }>>(
    (resolve) => {
      timer = setTimeout(
        () => resolve(Exit.fail({ _tag: "Timeout" as const, afterMillis: deadlineMillis })),
        deadlineMillis,
      );
    },
  );
  return Promise.race([
    Effect.runPromiseExit(effect).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    }),
    timeout,
  ]);
};
