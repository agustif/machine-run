import type { CommandError } from "alchemy/Command";

/**
 * Whether a failed command's real exit status was exactly `code`.
 *
 * `git config` overloads its exit codes with meaning (`man git-config`'s
 * FILES/EXIT sections): 1 for "no such key" *and* "invalid key syntax", 5 for
 * "nothing to unset" *and* "multiple values match", and so on. Alchemy's
 * `CommandExecutor.run` fails the effect on any non-zero exit, so the only way
 * to tell "this exit code means the ordinary case" from "this exit code means
 * a real problem" is to inspect the `UnexpectedExit` reason inside the
 * `CommandError` — a spawn failure or timeout never has an exit code at all,
 * and must not be mistaken for one.
 */
export const isExitCode = (error: CommandError, code: number): boolean =>
  error.reason._tag === "UnexpectedExit" && error.reason.exitCode === code;

/**
 * `stderr` from a failed command's `UnexpectedExit` reason, or `""` for any
 * other failure shape (a spawn failure, a timeout — neither ran a process
 * that could have written to `stderr`).
 */
export const stderrOf = (error: CommandError): string =>
  error.reason._tag === "UnexpectedExit" ? error.reason.stderr : "";
