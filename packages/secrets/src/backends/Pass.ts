import { Sh } from "@machine-run/core";
import type { CommandError } from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  SecretCliMissing,
  type SecretBackend,
  type SecretError,
  SecretReadFailed,
} from "../Backend.ts";

/**
 * `pass`, the standard Unix password manager (GPG-backed).
 *
 * References are store paths, e.g. `work/github/token`. `pass show <path>`
 * prints the entry; by convention the first line is the secret and any
 * following lines are metadata, so only the first line is returned.
 *
 * There is no auth step to classify: `pass` delegates to `gpg-agent`, which
 * prompts through its own pinentry rather than failing with a
 * "not signed in" message.
 */
export const PassBackend: SecretBackend = {
  id: "pass",
  read: (ref, exec) =>
    exec({ command: Sh.sh("pass", "show", ref), shell: true }).pipe(
      Effect.map((result) => Redacted.make(result.stdout.split("\n")[0] ?? "")),
      Effect.catchTag("CommandError", (error) => Effect.fail(classify(ref, error))),
    ),
};

const classify = (ref: string, cause: CommandError): SecretError => {
  const message = cause.message.toLowerCase();
  if (message.includes("command not found") || message.includes("enoent")) {
    return new SecretCliMissing({
      backend: "pass",
      cli: "pass",
      install: "Install it — e.g. `brew install pass` or `apt-get install pass`.",
      cause,
    });
  }
  return new SecretReadFailed({ backend: "pass", ref, cause });
};
