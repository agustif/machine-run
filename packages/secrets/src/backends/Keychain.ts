import { Sh } from "@machine-run/core";
import type { CommandError } from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as UndefinedOr from "effect/UndefinedOr";
import {
  SecretCliMissing,
  type SecretBackend,
  type SecretError,
  SecretNotFound,
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
 * than a CLI error — see {@link isNoSuchKeychainItem} for what was verified
 * about that, and why it means every failure other than a genuine missing
 * entry must be treated as opaque.
 *
 * KNOWN BUG, verified on real macOS (2026-08-14), not merely suspected:
 * `security find-generic-password -w` prints the ASCII-hex encoding of the
 * stored bytes — not the bytes themselves — whenever the value contains a
 * byte outside `isprint()`'s range. A value with an embedded newline (an SSH
 * private key, a PEM certificate, any multi-line secret — exactly what
 * `Machine.SecretFile` most needs to get right) or even a single embedded
 * tab comes back as a hex string instead of its real value, silently, with
 * exit code `0`; a plain single-line ASCII value comes back verbatim. There
 * is no reliable way to tell the two cases apart from `-w`'s output alone —
 * a hex-looking result is ambiguous between "this is the fallback encoding"
 * and "this genuinely is the secret, and it happens to look like hex".
 * `security find-generic-password -g` does disambiguate (`password:
 * 0x<hex>` versus a bare `password: "quoted string"`), so the real fix is to
 * read via `-g` and parse both of its forms instead of `-w` — a real change
 * to `read` below, not a documentation fix, and out of scope for the
 * session that found this (see `docs/notes/secrets-keychain-notes.md` and
 * `packages/secrets/test/fixtures/keychain-multiline-hex-stdout.txt` for the
 * full captured evidence, and `packages/secrets/TASKS.md` for the fix this
 * still needs).
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
  if (isNoSuchKeychainItem(cause)) {
    return new SecretNotFound({ source, cause });
  }
  return new SecretReadFailed({ source, cause });
};

/**
 * `security find-generic-password`'s signal for "no such entry" — the one
 * case {@link SecretNotFound} exists to carry, since `DataKey.ts`'s
 * `ensureDataKey` builds real control-flow on it (mint a key only here).
 *
 * Matched structurally, on `reason`'s `_tag` and `exitCode`, the same way
 * `@machine-run/core`'s `isNotFound` matches a `PlatformError`'s reason tag
 * rather than its message — not on `cause.message` text the way
 * `SecretCliMissing`/`SecretAuthRequired` above do, because those two are
 * best-effort UX buckets (AGENTS.md #11: "don't build control flow on the
 * finer buckets") while this one is exactly the finer bucket the fix is
 * built on, so it needs the more stable signal.
 *
 * Verified against the real `security` CLI on macOS (2026-08-14):
 * `security find-generic-password -s <nonexistent-service> -w` exited `44`
 * with stderr `security: SecKeychainSearchCopyNext: The specified item
 * could not be found in the keychain.` — matching the fixture this
 * package's tests already used. The stderr substring is checked alongside
 * the exit code (not instead of it) since an exit code alone, from a
 * third-party CLI, is a weaker guarantee than a first-party `PlatformError`
 * reason tag.
 *
 * A *locked* keychain does not reproduce this: querying a disposable test
 * keychain (never the login keychain) after locking it did not exit within
 * 120 seconds — it blocked on an interactive Security Agent prompt instead
 * of failing programmatically. That case, and every other `security`
 * failure, therefore falls through to {@link SecretReadFailed} below.
 */
const isNoSuchKeychainItem = (cause: CommandError): boolean =>
  cause.reason._tag === "UnexpectedExit" &&
  cause.reason.exitCode === 44 &&
  cause.reason.stderr.toLowerCase().includes("could not be found in the keychain");
