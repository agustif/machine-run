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
} from "../Backend.ts";

/**
 * 1Password, via the `op` CLI.
 *
 * References are `op://<vault>/<item>/<field>` secret references — the same
 * syntax `op read` and `op inject` accept.
 *
 * No output-shaping flags are passed: `op` is not installed on the machine
 * this was written on, and guessing at a CLI's surface is worse than an
 * acknowledged gap. Whatever `op read` prints is returned verbatim, and
 * `Machine.SecretFile`'s `trailingNewline` decides the file's final byte.
 * See docs/TASKS.md for verifying this against a real `op`.
 */
export const OnePasswordBackend: SecretBackend = {
  id: "1password",
  read: (ref, exec) =>
    exec({ command: Sh.sh("op", "read", ref), shell: true }).pipe(
      Effect.map((result) => Redacted.make(result.stdout)),
      Effect.catchTag("CommandError", (error) => Effect.fail(classify(ref, error))),
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
const classify = (ref: string, cause: CommandError): SecretError => {
  const message = cause.message.toLowerCase();
  if (message.includes("command not found") || message.includes("enoent")) {
    return new SecretCliMissing({
      backend: "1password",
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
      backend: "1password",
      signInCommand: "op signin",
      cause,
    });
  }
  return new SecretReadFailed({ backend: "1password", ref, cause });
};
