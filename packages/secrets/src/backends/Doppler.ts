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
  SecretRefInvalid,
} from "../Backend.ts";

/**
 * Doppler, via `doppler secrets get`.
 *
 * References are `<project>/<config>/<SECRET_NAME>`, e.g. `backend/dev/API_KEY`.
 *
 * Doppler also supports injecting secrets as environment variables into a
 * command (`doppler run`). That is a useful shape but it is not a store
 * *read*, so it cannot back `Machine.SecretFile` and does not belong on this
 * interface; it fits a command-running resource instead.
 *
 * Verified against `doppler secrets get --help` (v3): `--plain` prints the
 * value with no table formatting, and `--project`/`--config` scope it.
 */
export const DopplerBackend: SecretBackend = {
  id: "doppler",
  read: (ref, exec) =>
    Effect.gen(function* () {
      const parsed = parseRef(ref);
      if (parsed === undefined) {
        return yield* Effect.fail(
          new SecretRefInvalid({
            backend: "doppler",
            ref,
            expected: "<project>/<config>/<SECRET_NAME>, e.g. backend/dev/API_KEY",
          }),
        );
      }

      const result = yield* exec({
        command: Sh.sh(
          "doppler",
          "secrets",
          "get",
          parsed.name,
          "--plain",
          "--project",
          parsed.project,
          "--config",
          parsed.config,
        ),
        shell: true,
      }).pipe(Effect.catchTag("CommandError", (error) => Effect.fail(classify(ref, error))));

      // `--plain` still terminates with a newline that is not part of the
      // stored value.
      return Redacted.make(result.stdout.replace(/\n$/, ""));
    }),
};

const parseRef = (ref: string): { project: string; config: string; name: string } | undefined => {
  const parts = ref.split("/");
  if (parts.length !== 3) return undefined;
  const [project, config, name] = parts;
  if (!project || !config || !name) return undefined;
  return { project, config, name };
};

const classify = (ref: string, cause: CommandError): SecretError => {
  const message = cause.message.toLowerCase();
  if (message.includes("command not found") || message.includes("enoent")) {
    return new SecretCliMissing({
      backend: "doppler",
      cli: "doppler",
      install: "Install it — e.g. `brew install dopplerhq/cli/doppler`.",
      cause,
    });
  }
  if (message.includes("unauthorized") || message.includes("invalid auth token")) {
    return new SecretAuthRequired({
      backend: "doppler",
      signInCommand: "doppler login",
      cause,
    });
  }
  return new SecretReadFailed({ backend: "doppler", ref, cause });
};
