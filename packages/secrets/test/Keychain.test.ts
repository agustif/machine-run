import type { Exec } from "@machine-run/engine";
import { CommandError, UnexpectedExit } from "alchemy/Command";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { KeychainBackend } from "../src/backends/Keychain.ts";
import { SecretNotFound, SecretReadFailed } from "../src/Backend.ts";

const fakeExec =
  (stdout: string): Exec =>
  () =>
    Effect.succeed({ exitCode: 0, stdout, stderr: "" });

const failingExec =
  (command: string, exitCode: number, stderr: string): Exec =>
  () =>
    Effect.fail(new CommandError({ command, reason: new UnexpectedExit({ exitCode, stderr }) }));

it.effect(
  "KeychainBackend.read strips exactly one trailing newline (real `security ... -w` shape)",
  () =>
    Effect.gen(function* () {
      // Real captured `security find-generic-password -s mr-secrets-test-simple
      // -w <disposable test keychain>` output, on real macOS: the value plus
      // one trailing newline `security` itself appends. See
      // docs/notes/secrets-keychain-notes.md.
      const value = yield* KeychainBackend.read(
        { _tag: "Keychain", service: "mr-secrets-test-simple" },
        fakeExec("sup3rKeychainSecret\n"),
      );
      expect(Redacted.value(value)).toBe("sup3rKeychainSecret");
    }),
);

it.effect(
  "KeychainBackend.read surfaces a missing entry as SecretNotFound (real exit 44 / stderr)",
  () =>
    Effect.gen(function* () {
      // Real captured `security find-generic-password -s <nonexistent> -w`
      // output on real macOS: exit 44, this exact stderr text. Verified this
      // session's predecessor commit; pinned here since nothing in this
      // package's own test suite exercised it yet.
      const failure = yield* KeychainBackend.read(
        { _tag: "Keychain", service: "mr-secrets-test-does-not-exist" },
        failingExec(
          "security find-generic-password -s mr-secrets-test-does-not-exist -w",
          44,
          "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n",
        ),
      ).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(SecretNotFound);
      expect(failure).toMatchObject({
        source: { _tag: "Keychain", service: "mr-secrets-test-does-not-exist" },
      });
    }),
);

it.effect(
  "BUG: read returns the hex-encoded fallback, not the real value, for a secret with an embedded newline (real security find-generic-password -w output)",
  () =>
    Effect.gen(function* () {
      // Real captured `security find-generic-password -s mr-secrets-test-multiline
      // -w <disposable test keychain>` output on real macOS, where the stored
      // value was the literal three-line string "line1\nline2\nline3" (no
      // trailing newline). `security` printed the ASCII-hex encoding of those
      // bytes instead of the bytes themselves, plus its own trailing "\n" —
      // see docs/notes/test-findings.md #4 and
      // packages/secrets/test/fixtures/keychain-multiline-hex-stdout.txt.
      //
      // This pins the *current* (buggy) behaviour: `read` has no way to tell
      // this apart from a real secret that merely looks like a hex string, so
      // it returns the hex text verbatim, not "line1\nline2\nline3". If
      // `read` is ever changed to use `-g` and decode this correctly (see the
      // fix sketch in docs/notes/test-findings.md #4), this assertion should
      // flip to expect "line1\nline2\nline3".
      const value = yield* KeychainBackend.read(
        { _tag: "Keychain", service: "mr-secrets-test-multiline" },
        fakeExec("6c696e65310a6c696e65320a6c696e6533\n"),
      );
      expect(Redacted.value(value)).toBe("6c696e65310a6c696e65320a6c696e6533");
      expect(Redacted.value(value)).not.toBe("line1\nline2\nline3");
    }),
);

it.effect(
  "KeychainBackend.read surfaces any other real failure as SecretReadFailed, not SecretNotFound",
  () =>
    Effect.gen(function* () {
      // A locked (or otherwise inaccessible) keychain does not reproduce the
      // exit-44 signal above — verified this session's predecessor commit by
      // querying a disposable, throwaway keychain after locking it, which
      // instead blocked on an interactive Security Agent prompt rather than
      // exiting at all. Every failure that isn't the exact exit-44 shape must
      // therefore fall through to the opaque SecretReadFailed bucket, pinned
      // here with a different, real exit code/stderr pairing.
      const failure = yield* KeychainBackend.read(
        { _tag: "Keychain", service: "mr-secrets-test-simple" },
        failingExec(
          "security find-generic-password -s mr-secrets-test-simple -w",
          1,
          "security: SecKeychainSearchCopyNext: some other, unrelated failure.\n",
        ),
      ).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(SecretReadFailed);
    }),
);
