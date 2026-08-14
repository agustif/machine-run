import { Sh } from "@machine-run/core";
import type { CommandError } from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  SecretAuthRequired,
  SecretCliMissing,
  type SecretBackend,
  type SecretError,
  SecretReadFailed,
  type SecretSource,
} from "../Backend.ts";

type OnePasswordSource = Extract<SecretSource, { _tag: "OnePassword" }>;

/**
 * 1Password, via the `op` CLI.
 *
 * `vault`/`item`/`field` are assembled into an `op://<vault>/<item>/<field>`
 * secret reference — the same syntax `op read` and `op inject` accept.
 *
 * No output-shaping flags are passed: `op` is not installed on the machine
 * this was written on, and guessing at a CLI's surface is worse than an
 * acknowledged gap. Whatever `op read` prints is returned verbatim, and
 * `Machine.SecretFile`'s `trailingNewline` decides the file's final byte.
 * See docs/TASKS.md for verifying this against a real `op`.
 */
export const OnePasswordBackend: SecretBackend<OnePasswordSource> = {
  id: "OnePassword",
  read: (source, exec) =>
    exec({
      command: Sh.sh("op", "read", `op://${source.vault}/${source.item}/${source.field}`),
      shell: true,
    }).pipe(
      Effect.map((result) => Redacted.make(result.stdout)),
      Effect.catchTag("CommandError", (error) => Effect.fail(classify(source, error))),
    ),
};

/**
 * Buckets a failure into something actionable.
 *
 * Substring matching on CLI output is inherently fragile — wording is not a
 * stable API and is not predictably localised. This exists to tell the
 * operator what to do next, with {@link SecretReadFailed} as the honest
 * fallback; control flow should not depend on the finer buckets.
 */
const classify = (source: OnePasswordSource, cause: CommandError): SecretError => {
  const message = cause.message.toLowerCase();
  if (message.includes("command not found") || message.includes("enoent")) {
    return new SecretCliMissing({
      source,
      cli: "op",
      install: 'Install it — e.g. add the "1password-cli" cask to this machine\'s packages.',
      cause,
    });
  }
  if (
    message.includes("not signed in") ||
    message.includes("no valid session") ||
    message.includes("authentication")
  ) {
    return new SecretAuthRequired({
      source,
      signInCommand: "op signin",
      cause,
    });
  }
  return new SecretReadFailed({ source, cause });
};
