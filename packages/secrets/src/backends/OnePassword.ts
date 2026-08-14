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
 * No output-shaping flags are passed: nothing here has read a real secret
 * from a real vault (that needs an account this environment deliberately
 * never creates, `AGENTS.md` rule 8). Whatever `op read` prints is returned
 * verbatim, and `Machine.SecretFile`'s `trailingNewline` decides the file's
 * final byte. See `packages/secrets/TASKS.md` for verifying this against a
 * real `op` read.
 *
 * `classify`'s `SecretAuthRequired` bucket, unlike the happy path, has been
 * checked against a real, unauthenticated `op` — see its own doc comment.
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
 *
 * Verified against a real `op` (2.38.1, installed from the official apt
 * repo inside `docker run --rm debian:stable`, zero accounts ever
 * configured): `op read op://Personal/does-not-exist/field` exited `1` with
 * stderr beginning `No accounts configured for use with 1Password CLI.` —
 * this contains none of `not signed in`/`no valid session`/`authentication`
 * (the CLI's own text reads "Authenticate", not "authentication"), so
 * before this session that real, very-likely-to-be-hit state fell through
 * to {@link SecretReadFailed} instead of {@link SecretAuthRequired}, the
 * opposite of what this comment used to claim. `no accounts configured` is
 * now also matched, against that real captured text (see
 * `docs/notes/secrets-op-notes.md` and
 * `packages/secrets/test/fixtures/op-unauthenticated-stderr.txt`). The
 * other three substrings are left in place as unverified: they may be
 * correct for a real *expired* session, which this environment cannot
 * produce without an account that has first signed in.
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
    message.includes("authentication") ||
    message.includes("no accounts configured")
  ) {
    return new SecretAuthRequired({
      source,
      signInCommand: "op signin",
      cause,
    });
  }
  return new SecretReadFailed({ source, cause });
};
