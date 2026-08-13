import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import * as Effect from "effect/Effect";

/**
 * A status session that reports nothing, for read-only probes during `plan`.
 *
 * ## Why this is needed
 *
 * Alchemy's `CommandExecutor.run(props, session)` requires a
 * `ScopedPlanStatusSession`, but the engine only threads one into `reconcile`,
 * `precreate` and `delete` — **`diff` and `read` receive no session at all**.
 *
 * That is a genuine constraint, not an oversight: `diff` runs during planning,
 * where there is no apply session to attach output to. But it means a resource
 * whose live state can only be observed by running a command —
 * `MacOS.Default` (`defaults read`), `System.Package` (`brew list`),
 * `Tailscale.Connection` (`tailscale status`) — cannot observe anything in
 * `diff` using the session-taking API.
 *
 * The interface is three methods, and all three exist purely to stream
 * progress to the CLI:
 *
 * ```ts
 * interface PlanStatusSession { emit; done }
 * interface ScopedPlanStatusSession extends PlanStatusSession { note }
 * ```
 *
 * `Command.ts` only ever calls `session.note` (to forward stdout/stderr lines
 * as they arrive). So a session that drops those lines is exactly right for a
 * plan-time probe: the probe's output is not progress the operator asked to
 * watch, it is an implementation detail of computing the diff.
 *
 * This is deliberately NOT used in `reconcile`, where the real session must be
 * threaded so the operator sees what the apply is doing.
 */
export const silentSession: ScopedPlanStatusSession = {
  emit: () => Effect.void,
  done: () => Effect.void,
  note: () => Effect.void,
};
