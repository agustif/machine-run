import { Sh } from "@machine-run/core";
import type { Exec } from "@machine-run/engine";
import type { CommandError } from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { isExitCode, stderrOf } from "./exitCode.ts";

/**
 * The repository root `target` is inside, or `None` if `target` is not
 * inside any git repository at all.
 *
 * Shared by `Repo.ts` (detecting the nested-repository trap — see its doc
 * comment) and `Maintenance.ts` (resolving the canonical form git itself
 * stores in `maintenance.repo`). Returns the raw `CommandError` on a genuine
 * failure rather than a package-specific tagged error, so each caller wraps
 * it into its own — `GitRepoCommandFailed`, `GitMaintenanceCommandFailed` —
 * without this module needing to know either exists.
 *
 * Verified: a fatal `rev-parse --show-toplevel` always exits `128`, but so do
 * unrelated fatal errors (a corrupt `.git`, an unreadable parent directory) —
 * exit code alone would misclassify those as "not a repository". The stderr
 * check is best-effort text matching for exactly that reason: it only
 * narrows the *common* case, and anything that doesn't match it is treated
 * as a real failure rather than silently swallowed.
 */
export const showToplevel = (
  target: string,
  exec: Exec,
): Effect.Effect<Option.Option<string>, CommandError> =>
  exec({
    command: Sh.sh("git", "-C", target, "rev-parse", "--show-toplevel"),
    shell: true,
  }).pipe(
    Effect.map((result) => Option.some(result.stdout.trim())),
    Effect.catch((error) =>
      isExitCode(error, 128) && /not a git repository/i.test(stderrOf(error))
        ? Effect.succeed(Option.none())
        : Effect.fail(error),
    ),
  );
