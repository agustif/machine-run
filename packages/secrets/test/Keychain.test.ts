import type { Exec } from "@machine-run/engine";
import { CommandError, UnexpectedExit } from "alchemy/Command";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { KeychainBackend } from "../src/backends/Keychain.ts";
import { SecretNotFound, SecretReadFailed } from "../src/Backend.ts";

const fakeExecOnStderr =
  (stderr: string): Exec =>
  () =>
    Effect.succeed({ exitCode: 0, stdout: "", stderr });

const fakeExecOnStdout =
  (stdout: string): Exec =>
  () =>
    Effect.succeed({ exitCode: 0, stdout, stderr: "" });

const failingExec =
  (command: string, exitCode: number, stderr: string): Exec =>
  () =>
    Effect.fail(new CommandError({ command, reason: new UnexpectedExit({ exitCode, stderr }) }));

it.effect(
  "KeychainBackend.read decodes the bare quoted form for a plain printable secret (real `security ... -g` output, on stderr)",
  () =>
    Effect.gen(function* () {
      // Real captured `security find-generic-password -s mrv-simple -g
      // <disposable test keychain>` output on real macOS: the password line
      // lands on stderr, not stdout, on this machine. See
      // test/fixtures/keychain-g-flag-transcript.txt case 1.
      const value = yield* KeychainBackend.read(
        { _tag: "Keychain", service: "mrv-simple" },
        fakeExecOnStderr('password: "sup3rKeychainSecret"\n'),
      );
      expect(Redacted.value(value)).toBe("sup3rKeychainSecret");
    }),
);

it.effect(
  "KeychainBackend.read checks stdout too, in case a macOS version puts the password line there instead",
  () =>
    Effect.gen(function* () {
      // Not observed on this machine (see the doc comment on
      // parseGeneralizedPassword in Keychain.ts), but the task that produced
      // this fix explicitly warned it varies by macOS version, so both
      // streams must work.
      const value = yield* KeychainBackend.read(
        { _tag: "Keychain", service: "mrv-simple" },
        fakeExecOnStdout('password: "sup3rKeychainSecret"\n'),
      );
      expect(Redacted.value(value)).toBe("sup3rKeychainSecret");
    }),
);

it.effect(
  "KeychainBackend.read decodes the 0x<hex> form correctly for a secret with embedded newlines (real security find-generic-password -g output) — this was the BUG: -w returned this same hex text as if it were the secret itself",
  () =>
    Effect.gen(function* () {
      // Real captured `security find-generic-password -s mrv-multiline -g
      // <disposable test keychain>` output on real macOS, where the stored
      // value was the literal three-line string "line1\nline2\nline3" (no
      // trailing newline). See docs/notes/test-findings.md #4 for the
      // original `-w` finding and test/fixtures/keychain-g-flag-transcript.txt
      // case 2 for this fix's `-g` verification.
      //
      // Before the fix, `read` used `-w` and had no way to tell this hex text
      // apart from a real secret that merely looks like a hex string, so it
      // returned "6c696e65310a6c696e65320a6c696e6533" verbatim instead of
      // "line1\nline2\nline3". `-g`'s 0x<hex> marker disambiguates the two
      // cases, which is exactly what this test now pins.
      const value = yield* KeychainBackend.read(
        { _tag: "Keychain", service: "mrv-multiline" },
        fakeExecOnStderr(
          'password: 0x6C696E65310A6C696E65320A6C696E6533  "line1\\012line2\\012line3"\n',
        ),
      );
      expect(Redacted.value(value)).toBe("line1\nline2\nline3");
    }),
);

it.effect(
  "KeychainBackend.read decodes the 0x<hex> form for a secret with an embedded tab (real security find-generic-password -g output)",
  () =>
    Effect.gen(function* () {
      // Real captured output for mrv-tab (stored: "tab<TAB>separated"). See
      // test/fixtures/keychain-g-flag-transcript.txt case 3.
      const value = yield* KeychainBackend.read(
        { _tag: "Keychain", service: "mrv-tab" },
        fakeExecOnStderr('password: 0x74616209736570617261746564  "tab\\011separated"\n'),
      );
      expect(Redacted.value(value)).toBe("tab\tseparated");
    }),
);

it.effect(
  "KeychainBackend.read round-trips a realistic multi-line PEM-shaped secret byte-exactly, including its own trailing newline",
  () =>
    Effect.gen(function* () {
      // Real captured output for mrv-pem-nl: a PEM-shaped OpenSSH-private-key
      // blob stored WITH a trailing newline of its own (the shape a real key
      // file on disk has). See test/fixtures/keychain-g-flag-transcript.txt
      // case 5, and case 4 for the same value without the trailing newline —
      // the two hex payloads differ by exactly one trailing `0a`/`\012`,
      // confirming `-g` (unlike `-w`) adds no byte of its own that would need
      // stripping.
      const pem =
        "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
        "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n" +
        "QyNTUxOQAAACD7fakevalueevaluevalueevaluevaluevalueevalueevaluevalueev\n" +
        "alueevaluevaluevaluevaluevaluevaluevaluevaluevaluevaluevaluevaluevalu\n" +
        "-----END OPENSSH PRIVATE KEY-----\n";
      const value = yield* KeychainBackend.read(
        { _tag: "Keychain", service: "mrv-pem-nl" },
        fakeExecOnStderr(
          'password: 0x2D2D2D2D2D424547494E204F50454E5353482050524956415445204B45592D2D2D2D2D0A6233426C626E4E7A614331725A586B74646A45414141414142473576626D554141414145626D39755A5141414141414141414142414141414D7741414141747A633267745A570A51794E5455784F5141414143443766616B6576616C75656576616C756576616C75656576616C756576616C756576616C75656576616C75656576616C756576616C756565760A616C75656576616C756576616C756576616C756576616C756576616C756576616C756576616C756576616C756576616C756576616C756576616C756576616C756576616C750A2D2D2D2D2D454E44204F50454E5353482050524956415445204B45592D2D2D2D2D0A  "-----BEGIN OPENSSH PRIVATE KEY-----\\012b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\\012QyNTUxOQAAACD7fakevalueevaluevalueevaluevaluevalueevalueevaluevalueev\\012alueevaluevaluevaluevaluevaluevaluevaluevaluevaluevaluevaluevaluevalu\\012-----END OPENSSH PRIVATE KEY-----\\012"\n',
        ),
      );
      expect(Redacted.value(value)).toBe(pem);
      expect(Redacted.value(value).endsWith("\n")).toBe(true);
    }),
);

it.effect(
  "KeychainBackend.read decodes the bare quoted form even when the value contains an embedded double quote (real security find-generic-password -g output) — the embedded quote is never escaped, but the outer delimiters are always the line's first and last characters",
  () =>
    Effect.gen(function* () {
      // Real captured output for mrv-quoteonly (stored: 'say "hi" now', a
      // printable value with an embedded quote but no backslash and no
      // non-printable byte — this is the one case that produces *only* the
      // bare quoted form, no 0x fallback). See
      // test/fixtures/keychain-g-flag-transcript.txt case 8.
      const value = yield* KeychainBackend.read(
        { _tag: "Keychain", service: "mrv-quoteonly" },
        fakeExecOnStderr('password: "say "hi" now"\n'),
      );
      expect(Redacted.value(value)).toBe('say "hi" now');
    }),
);

it.effect(
  "KeychainBackend.read decodes the 0x<hex> form for a value containing a literal backslash — the hex fallback triggers even though every byte is printable ASCII",
  () =>
    Effect.gen(function* () {
      // Real captured output for mrv-backslash (stored: 'back\slash', no
      // quote, no non-printable byte, but a bare backslash still produces the
      // 0x fallback rather than only the quoted form). See
      // test/fixtures/keychain-g-flag-transcript.txt case 7.
      const value = yield* KeychainBackend.read(
        { _tag: "Keychain", service: "mrv-backslash" },
        fakeExecOnStderr('password: 0x6261636B5C736C617368  "back\\134slash"\n'),
      );
      expect(Redacted.value(value)).toBe("back\\slash");
    }),
);

it.effect(
  "KeychainBackend.read decodes the 0x<hex> form for a UTF-8 secret with a multi-byte character",
  () =>
    Effect.gen(function* () {
      // Real captured output for mrv-utf8 (stored: "café🔑"). See
      // test/fixtures/keychain-g-flag-transcript.txt case 10.
      const value = yield* KeychainBackend.read(
        { _tag: "Keychain", service: "mrv-utf8" },
        fakeExecOnStderr('password: 0x636166C3A9F09F9491  "caf\\303\\251\\360\\237\\224\\221"\n'),
      );
      expect(Redacted.value(value)).toBe("café🔑");
    }),
);

it.effect(
  "KeychainBackend.read surfaces a missing entry as SecretNotFound (real exit 44 / stderr, unchanged by the -w -> -g switch)",
  () =>
    Effect.gen(function* () {
      // Real captured `security find-generic-password -s <nonexistent> -g`
      // output on real macOS: exit 44, this exact stderr text — byte-for-byte
      // identical to what `-w` produced for the same missing entry, so
      // isNoSuchKeychainItem's classification needed no changes. See
      // test/fixtures/keychain-g-flag-transcript.txt's "missing-entry check".
      const failure = yield* KeychainBackend.read(
        { _tag: "Keychain", service: "mr-secrets-test-does-not-exist" },
        failingExec(
          "security find-generic-password -s mr-secrets-test-does-not-exist -g",
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
  "KeychainBackend.read surfaces any other real failure as SecretReadFailed, not SecretNotFound",
  () =>
    Effect.gen(function* () {
      // A locked (or otherwise inaccessible) keychain does not reproduce the
      // exit-44 signal above — verified against a disposable, throwaway
      // keychain locked and then queried, which instead blocked on an
      // interactive Security Agent prompt rather than exiting at all. Every
      // failure that isn't the exact exit-44 shape must therefore fall
      // through to the opaque SecretReadFailed bucket, pinned here with a
      // different, real exit code/stderr pairing.
      const failure = yield* KeychainBackend.read(
        { _tag: "Keychain", service: "mrv-simple" },
        failingExec(
          "security find-generic-password -s mrv-simple -g",
          1,
          "security: SecKeychainSearchCopyNext: some other, unrelated failure.\n",
        ),
      ).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(SecretReadFailed);
    }),
);

it.effect(
  "KeychainBackend.read fails with SecretReadFailed (not a garbled value) when -g's output doesn't contain a recognizable password line at all",
  () =>
    Effect.gen(function* () {
      // Defensive: never observed against real `security`, but if a future
      // macOS version changes -g's success-path shape entirely, this must
      // fail loudly rather than silently return something wrong — the exact
      // failure mode this whole fix exists to close off.
      const failure = yield* KeychainBackend.read(
        { _tag: "Keychain", service: "mrv-simple" },
        fakeExecOnStderr('keychain: "/some/keychain-db"\nversion: 256\nclass: "genp"\n'),
      ).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(SecretReadFailed);
    }),
);
