import { Sh } from "@machine-run/core";
import type { CommandError } from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  SecretCliMissing,
  type SecretBackend,
  type SecretError,
  SecretReadFailed,
  type SecretSource,
} from "../Backend.ts";

type PassSource = Extract<SecretSource, { _tag: "Pass" }>;

/**
 * `pass`, the standard Unix password manager (GPG-backed).
 *
 * `path` is a store path, e.g. `work/github/token`. `pass show <path>`
 * prints the entry; by convention the first line is the secret and any
 * following lines are metadata, so only the first line is returned.
 *
 * There is no auth step to classify: `pass` delegates to `gpg-agent`, which
 * prompts through its own pinentry rather than failing with a
 * "not signed in" message.
 *
 * Verified end to end against `docker run --rm debian:stable`: `apt-get
 * install pass gnupg pinentry-curses`, a real GPG key generated with `gpg
 * --batch --gen-key` (no passphrase, so nothing here needed to automate a
 * pinentry prompt), `pass init <email>`, then `pass insert -m <path>` for
 * both a single-line secret and a multi-line one (secret plus two metadata
 * lines). `pass show` printed each back verbatim — `sup3rsecret` for the
 * single-line entry, and the full three lines for the multi-line one —
 * confirming `.split("\n")[0]` really does isolate the secret from
 * metadata `pass insert -m` happily stores alongside it, not just in
 * theory. `pass show <ref that was never inserted>` failed with `Error:
 * <ref> is not in the password store.` on stderr, exit 1: this message
 * contains neither "command not found" nor "enoent", so `classify` falls
 * through to `SecretReadFailed` rather than misreading a missing *entry* as
 * a missing *CLI* — confirmed, not assumed (fixtures inline in
 * `test/Pass.test.ts`; see `docs/notes/secrets-pass-notes.md` for the full
 * session). This is the first backend in the `secrets` seam to read a real
 * secret from a real vault.
 */
export const PassBackend: SecretBackend<PassSource> = {
  id: "Pass",
  read: (source, exec) =>
    exec({ command: Sh.sh("pass", "show", source.path), shell: true }).pipe(
      Effect.map((result) => Redacted.make(result.stdout.split("\n")[0] ?? "")),
      Effect.catchTag("CommandError", (error) => Effect.fail(classify(source, error))),
    ),
};

const classify = (source: PassSource, cause: CommandError): SecretError => {
  const message = cause.message.toLowerCase();
  if (message.includes("command not found") || message.includes("enoent")) {
    return new SecretCliMissing({
      source,
      cli: "pass",
      install: "Install it — e.g. `brew install pass` or `apt-get install pass`.",
      cause,
    });
  }
  return new SecretReadFailed({ source, cause });
};
