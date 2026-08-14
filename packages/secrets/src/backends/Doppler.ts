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

type DopplerSource = Extract<SecretSource, { _tag: "Doppler" }>;

/**
 * Doppler, via `doppler secrets get`.
 *
 * `project`/`config`/`name` are Doppler's own three-part addressing —
 * `<project>/<config>/<SECRET_NAME>`, e.g. `backend/dev/API_KEY` — now
 * separate fields instead of one string this backend had to split itself.
 *
 * Doppler also supports injecting secrets as environment variables into a
 * command (`doppler run`). That is a useful shape but it is not a store
 * *read*, so it cannot back `Machine.SecretFile` and does not belong on this
 * interface; it fits a command-running resource instead.
 *
 * Verified against `doppler secrets get --help` (v3): `--plain` prints the
 * value with no table formatting, and `--project`/`--config` scope it. That
 * confirms the CLI's contract, not its output — nothing here has read a
 * real secret from a real Doppler project (`AGENTS.md` rule 8: no account
 * exists to create one with). `classify`'s `SecretAuthRequired` bucket has,
 * unlike the happy path, been checked against a real, unauthenticated
 * `doppler` — see its own doc comment.
 */
export const DopplerBackend: SecretBackend<DopplerSource> = {
  id: "Doppler",
  read: (source, exec) =>
    exec({
      command: Sh.sh(
        "doppler",
        "secrets",
        "get",
        source.name,
        "--plain",
        "--project",
        source.project,
        "--config",
        source.config,
      ),
      shell: true,
    }).pipe(
      // `--plain` still terminates with a newline that is not part of the
      // stored value.
      Effect.map((result) => Redacted.make(result.stdout.replace(/\n$/, ""))),
      Effect.catchTag("CommandError", (error) => Effect.fail(classify(source, error))),
    ),
};

/**
 * Verified against a real `doppler` (v3.76.4, installed from the official
 * apt repo inside `docker run --rm debian:stable`) in two unauthenticated
 * states. With no `DOPPLER_TOKEN` and never logged in, `doppler secrets get`
 * exited `1` with stderr `Doppler Error: you must provide a token` — this
 * matched neither `unauthorized` nor `invalid auth token`, so this real and
 * arguably more common "never configured at all" state used to fall through
 * to {@link SecretReadFailed} instead of {@link SecretAuthRequired}.
 * `you must provide a token` is now also matched, against that real
 * captured text. With a syntactically plausible but fake
 * `DOPPLER_TOKEN` set, the real error was `Doppler Error: Invalid Auth
 * token` — this does contain `invalid auth token`, so that half of the
 * classifier was already correct, not merely plausible (see
 * `docs/notes/secrets-doppler-notes.md` and
 * `packages/secrets/test/fixtures/doppler-no-token-stderr.txt` /
 * `doppler-invalid-token-stderr.txt`).
 */
const classify = (source: DopplerSource, cause: CommandError): SecretError => {
  const message = cause.message.toLowerCase();
  if (message.includes("command not found") || message.includes("enoent")) {
    return new SecretCliMissing({
      source,
      cli: "doppler",
      install: "Install it — e.g. `brew install dopplerhq/cli/doppler`.",
      cause,
    });
  }
  if (
    message.includes("unauthorized") ||
    message.includes("invalid auth token") ||
    message.includes("you must provide a token")
  ) {
    return new SecretAuthRequired({
      source,
      signInCommand: "doppler login",
      cause,
    });
  }
  return new SecretReadFailed({ source, cause });
};
