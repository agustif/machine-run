import { Sh } from "@machine-run/core";
import type { CommandError } from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as UndefinedOr from "effect/UndefinedOr";
import {
  SecretCliMissing,
  type SecretBackend,
  type SecretError,
  SecretReadFailed,
  type SecretSource,
} from "../Backend.ts";

type KeychainSource = Extract<SecretSource, { _tag: "Keychain" }>;

/**
 * The macOS login keychain, via `security find-generic-password`.
 *
 * `service` and the optional `account` map directly onto the `-s` and `-a`
 * flags. `-w` prints only the password to stdout.
 *
 * There is no separate sign-in step to classify: the keychain unlocks with the
 * login session, and a locked one produces an interactive GUI prompt rather
 * than a CLI error.
 */
export const KeychainBackend: SecretBackend<KeychainSource> = {
  id: "Keychain",
  read: (source, exec) =>
    exec({
      command: Sh.sh(
        "security",
        "find-generic-password",
        "-s",
        source.service,
        ...UndefinedOr.match(source.account, {
          onUndefined: (): ReadonlyArray<string> => [],
          onDefined: (account) => ["-a", account],
        }),
        "-w",
      ),
      shell: true,
    }).pipe(
      // `-w` terminates the password with a newline that is not part of the
      // stored value. Exactly that one trailing newline is removed, and
      // nothing else, so a secret whose own final byte is a newline is not
      // silently truncated.
      Effect.map((result) => Redacted.make(result.stdout.replace(/\n$/, ""))),
      Effect.catchTag("CommandError", (error) => Effect.fail(classify(source, error))),
    ),
};

const classify = (source: KeychainSource, cause: CommandError): SecretError => {
  const message = cause.message.toLowerCase();
  if (message.includes("command not found") || message.includes("enoent")) {
    return new SecretCliMissing({
      source,
      cli: "security",
      install: "This ships with macOS — a missing `security` means this is not a Mac.",
      cause,
    });
  }
  return new SecretReadFailed({ source, cause });
};
