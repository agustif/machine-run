import { Sh } from "@machine-run/core";
import type { CommandOutput } from "@machine-run/engine";
import type { CommandError } from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
 * flags. There is no separate sign-in step to classify: the keychain unlocks
 * with the login session, and a locked one produces an interactive GUI
 * prompt rather than a CLI error — see {@link isNoSuchKeychainItem} for what
 * was verified about that, and why it means every failure other than a
 * genuine missing entry must be treated as opaque.
 *
 * ## Why `-g`, not `-w`
 *
 * `-w` prints only the password to stdout, but was verified on real macOS
 * (2026-08-14) to silently print the **ASCII-hex encoding of the stored
 * bytes, not the bytes themselves**, whenever the value contains a byte
 * outside `isprint()`'s range — exit `0`, nothing on stderr. Every value
 * `Machine.SecretFile` most needs to get right (an SSH private key, a PEM
 * certificate, any multi-line secret) is multi-line by construction, so `-w`
 * corrupted exactly the cases that mattered most (see
 * `docs/notes/test-findings.md` #4 for the original finding).
 *
 * `-g` disambiguates where `-w` cannot: verified against a disposable test
 * keychain (never the login keychain) on this same machine, it reports
 * `password: 0x<HEX>  "<quoted rendering>"` for the raw-byte fallback and a
 * bare `password: "<quoted>"` for the printable case — so `read` below
 * parses `-g`'s output instead of trusting `-w`'s ambiguous one. See
 * {@link parseGeneralizedPassword} for exactly what was observed and how
 * each form is decoded, and `docs/notes/secrets-keychain-notes.md` /
 * `packages/secrets/test/fixtures/` for the full captured sessions (both the
 * original `-w` finding and this fix's `-g` verification).
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
        "-g",
      ),
      shell: true,
    }).pipe(
      Effect.flatMap((result) =>
        parseGeneralizedPassword(result).pipe(
          Option.match({
            onNone: () => Effect.fail(new SecretReadFailed({ source, cause: undefined })),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
      ),
      Effect.catchTag("CommandError", (error) => Effect.fail(classify(source, error))),
    ),
};

/**
 * The one line `-g` emits for the secret itself, e.g.
 * `password: 0x6C696E65310A6C696E65320A6C696E6533  "line1\012line2\012line3"`
 * or, for a plain printable value, `password: "sup3rSecret"`. Matched with
 * `m` so it can be pulled out of the surrounding attribute dump (`keychain:
 * ...`, `class: "genp"`, `attributes: ...`) that `-g` also prints.
 */
const PASSWORD_LINE = /^password: (.*)$/m;

/**
 * The raw-byte fallback form: `0x<hex digits>`, optionally followed by a
 * trailing quoted rendering of the same bytes on the same line (observed
 * whenever the value contains any byte outside `isprint()`'s range, and also
 * whenever it contains a literal backslash — see the verification note
 * below). The trailing quoted half is not captured; the hex is the ground
 * truth and is decoded directly.
 */
const HEX_FORM = /^0x([0-9A-Fa-f]+)(?:\s+".*")?$/;

/**
 * The bare printable form: `"<value>"` with no `0x` prefix. Captured
 * greedily so an embedded, unescaped `"` in the value (verified below) does
 * not truncate the match early — the regex engine backtracks to the last
 * `"` on the line, which is always the true closing delimiter, since `-g`
 * never escapes an embedded quote.
 */
const QUOTED_FORM = /^"([\s\S]*)"$/;

/**
 * Finds and decodes `-g`'s `password: ...` line from a command's output,
 * checking stderr before stdout.
 *
 * Verified directly against a disposable test keychain on real macOS
 * (Darwin, 2026-08-14; never the login keychain, deleted afterward),
 * reading back a plain printable value, a value with embedded newlines, one
 * with an embedded tab, a realistic multi-line PEM-shaped blob (with and
 * without a trailing newline of its own), and values built specifically to
 * probe the quoted form's escaping (an embedded double quote, an embedded
 * backslash, and a UTF-8 value with a multi-byte character):
 *
 * - **Stream**: on this machine, `security find-generic-password -g` prints
 *   the `password: ...` line to **stderr**, not stdout (the attribute dump —
 *   `keychain:`, `version:`, `class:`, `attributes:` — goes to stdout, with
 *   no password line in it at all). Since the task's own brief warns this
 *   differs across macOS versions, both streams are checked, stderr first.
 * - **Hex form triggers on more than non-printable bytes**: as expected, a
 *   value with an embedded newline or tab produced `0x<hex>  "<quoted, with
 *   \NNN octal escapes>"`. Unexpectedly, a value containing only printable
 *   ASCII *and a literal backslash* — no non-printable byte at all — also
 *   produced the `0x<hex>` form (backslash itself is escaped in the quoted
 *   half as octal `\134`). The hex is decoded directly in every case where
 *   it's present, so this is harmless either way.
 * - **Quoted-only form does not escape embedded double quotes**: a value
 *   containing a literal `"` but no backslash and no non-printable byte
 *   produced *only* the bare quoted form (no `0x` fallback) — with the
 *   embedded quote left completely unescaped, e.g. `password: "say "hi"
 *   now"` for the stored value `say "hi" now`. This is unambiguous to parse
 *   correctly *only* because the outer quotes are always exactly the first
 *   and last characters of the payload — {@link QUOTED_FORM}'s greedy match
 *   relies on exactly that, not on any escaping convention, since embedded
 *   quotes are not escaped at all.
 * - **No extra trailing newline**: unlike `-w`, which always appends one
 *   `\n` of its own after the password that is not part of the stored
 *   value, `-g`'s hex and quoted forms encode the stored bytes exactly —
 *   confirmed by comparing the same PEM-shaped value stored with and without
 *   its own trailing newline: the hex output differed by exactly one
 *   trailing `0a` (`\012` in the quoted half), with nothing extra added by
 *   `security` itself. So neither decoded form needs the trailing-newline
 *   stripping `-w`'s output required.
 */
const parseGeneralizedPassword = (result: CommandOutput): Option.Option<Redacted.Redacted<string>> =>
  findPasswordPayload(result).pipe(Option.flatMap(decodeGeneralizedPassword));

const findPasswordPayload = (result: CommandOutput): Option.Option<string> =>
  Option.fromUndefinedOr(PASSWORD_LINE.exec(result.stderr)?.[1]).pipe(
    Option.orElse(() => Option.fromUndefinedOr(PASSWORD_LINE.exec(result.stdout)?.[1])),
  );

const decodeGeneralizedPassword = (payload: string): Option.Option<Redacted.Redacted<string>> =>
  Option.fromUndefinedOr(HEX_FORM.exec(payload)?.[1]).pipe(
    Option.map((hex: string) => Redacted.make(Buffer.from(hex, "hex").toString("utf8"))),
    Option.orElse(() =>
      Option.fromUndefinedOr(QUOTED_FORM.exec(payload)?.[1]).pipe(
        Option.map((value) => Redacted.make(value)),
      ),
    ),
  );

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
 * package's tests already used. `-g` reproduces the identical exit code and
 * stderr for a missing entry (only the success path's output shape differs
 * between the two flags), so this classification is unaffected by the `-w`
 * → `-g` switch.
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
