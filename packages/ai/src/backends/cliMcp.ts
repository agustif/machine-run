import { Sh } from "@machine-run/core";
import type { CommandError } from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { AiToolCliMissing, type AiToolId } from "../Backend.ts";

/**
 * Best-effort sniff of a `CommandError` caused by a missing binary, the same
 * heuristic `Tailscale.Connection` uses. CLI wording is not a stable API, so
 * this only ever promotes an error to a more actionable one; every other
 * non-zero exit keeps its ordinary meaning (see each backend's own
 * `observe`).
 */
export const isCommandNotFound = (error: CommandError): boolean => {
  const message = error.message.toLowerCase();
  return message.includes("command not found") || message.includes("enoent");
};

/**
 * Promotes a `CommandError` to {@link AiToolCliMissing} when it looks like
 * the binary itself is absent, and passes every other `CommandError` through
 * unchanged. A named function with an explicit return type, rather than an
 * inline ternary inside `Effect.catchTag`, because the two branches return
 * `Effect.fail` over two different error types and TypeScript needs that
 * annotation to unify them into one result type.
 */
export const classifyCliError = (
  tool: AiToolId,
  cli: string,
  error: CommandError,
): Effect.Effect<never, AiToolCliMissing | CommandError> =>
  isCommandNotFound(error)
    ? Effect.fail(new AiToolCliMissing({ tool, cli, cause: error }))
    : Effect.fail(error);

/**
 * A `KEY<separator>VALUE`-shaped CLI token — `KEY=VALUE` for an env flag,
 * `"KEY: VALUE"` for a header flag — built so a secret-sourced value never
 * passes through this process's own string-building as plaintext.
 *
 * A literal value is single-quoted as one opaque unit; single-quoting
 * suppresses shell expansion entirely, which is exactly what a value with no
 * expansion to perform needs. A `Redacted` value instead goes into `env`
 * (mutating the caller's accumulator) and the token references it as
 * `"$<varName>"` — double-quoted, so `/bin/sh` expands it at the moment the
 * target CLI is spawned. The plaintext bytes are therefore never assembled
 * into a string by this backend's own code; they only ever exist inside
 * `Exec`'s `env` map (which Alchemy's redactor scrubs from logs and error
 * messages) and, briefly, in the spawned CLI's own process arguments — the
 * same exposure any CLI that accepts a secret as a flag has regardless of
 * how the caller got the value there, and not something this backend adds.
 */
export const metaToken = (
  key: string,
  value: string | Redacted.Redacted<string>,
  separator: "=" | ": ",
  varName: string,
  env: Record<string, string | Redacted.Redacted<string>>,
): string => {
  if (!Redacted.isRedacted(value)) return Sh.quote(`${key}${separator}${value}`);
  env[varName] = value;
  return `"${key}${separator}$${varName}"`;
};
