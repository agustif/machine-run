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
 * The macOS login keychain, via `security find-generic-password`.
 *
 * References are `<service>` or `<service>/<account>`, matching the `-s` and
 * `-a` flags. `-w` prints only the password to stdout.
 *
 * There is no separate sign-in step to classify: the keychain unlocks with the
 * login session, and a locked one produces an interactive GUI prompt rather
 * than a CLI error.
 */
export const KeychainBackend: SecretBackend = {
  id: "keychain",
  read: (ref, exec) => {
    const [service, account] = splitRef(ref);
    return exec({
      command: Sh.sh(
        "security",
        "find-generic-password",
        "-s",
        service,
        ...(account !== undefined ? ["-a", account] : []),
        "-w",
      ),
      shell: true,
    }).pipe(
      // `-w` terminates the password with a newline that is not part of the
      // stored value. Exactly that one trailing newline is removed, and
      // nothing else, so a secret whose own final byte is a newline is not
      // silently truncated.
      Effect.map((result) => Redacted.make(result.stdout.replace(/\n$/, ""))),
      Effect.catchTag("CommandError", (error) => Effect.fail(classify(ref, error))),
    );
  },
};

const splitRef = (ref: string): [string, string | undefined] => {
  const index = ref.indexOf("/");
  if (index === -1) return [ref, undefined];
  return [ref.slice(0, index), ref.slice(index + 1)];
};

const classify = (ref: string, cause: CommandError): SecretError => {
  const message = cause.message.toLowerCase();
  if (message.includes("command not found") || message.includes("enoent")) {
    return new SecretCliMissing({
      backend: "keychain",
      cli: "security",
      install: "This ships with macOS — a missing `security` means this is not a Mac.",
      cause,
    });
  }
  return new SecretReadFailed({ backend: "keychain", ref, cause });
};
