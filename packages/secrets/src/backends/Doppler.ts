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
 * value with no table formatting, and `--project`/`--config` scope it.
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
  if (message.includes("unauthorized") || message.includes("invalid auth token")) {
    return new SecretAuthRequired({
      source,
      signInCommand: "doppler login",
      cause,
    });
  }
  return new SecretReadFailed({ source, cause });
};
