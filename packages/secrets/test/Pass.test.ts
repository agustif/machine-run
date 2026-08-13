import type { Exec } from "@machine-run/engine";
import { CommandError, UnexpectedExit } from "alchemy/Command";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { PassBackend } from "../src/backends/Pass.ts";
import { SecretReadFailed } from "../src/Backend.ts";

/**
 * `pass` verified end to end against `docker run --rm debian:stable`: a
 * real GPG key (`gpg --batch --gen-key`, no passphrase), `pass init
 * <email>`, then `pass insert -m <path>` for both a single-line secret and a
 * multi-line one (secret plus metadata, the shape `PassBackend`'s own doc
 * comment assumes). `pass show` printed the value back verbatim in both
 * cases, and `pass show <ref-that-was-never-inserted>` failed with `Error:
 * <ref> is not in the password store.` on stderr, exit 1 — real captured
 * text used as `UnexpectedExit`'s `stderr` below, not invented.
 *
 * This is the first backend in the `secrets` seam to read a real secret
 * from a real (if disposable) vault — see
 * `docs/notes/secrets-pass-notes.md` for the full session.
 */
const fakeExec =
  (stdout: string): Exec =>
  () =>
    Effect.succeed({ exitCode: 0, stdout, stderr: "" });

const failingExec =
  (command: string, stderr: string): Exec =>
  () =>
    Effect.fail(new CommandError({ command, reason: new UnexpectedExit({ exitCode: 1, stderr }) }));

it.effect("PassBackend.read returns only the first line (real `pass show`, single-line secret)", () =>
  Effect.gen(function* () {
    const value = yield* PassBackend.read("work/github/token", fakeExec("sup3rsecret\n"));
    expect(Redacted.value(value)).toBe("sup3rsecret");
  }),
);

it.effect(
  "PassBackend.read drops metadata lines below the secret (real `pass show`, multi-line entry)",
  () =>
    Effect.gen(function* () {
      // Real captured `pass show work/github/pat` output: the secret on
      // line 1, then two metadata lines `pass insert -m` happily stores
      // alongside it. Only the first line is the secret this backend
      // returns — the rest is exactly the "any following lines are
      // metadata" convention the module doc comment describes.
      const value = yield* PassBackend.read(
        "work/github/pat",
        fakeExec("ghp_abc123XYZ\nusername: agustif\nurl: https://github.com\n"),
      );
      expect(Redacted.value(value)).toBe("ghp_abc123XYZ");
    }),
);

it.effect("PassBackend.read surfaces a missing entry as SecretReadFailed, not SecretCliMissing", () =>
  Effect.gen(function* () {
    const failure = yield* PassBackend.read(
      "nope/does/not/exist",
      failingExec(
        "pass show nope/does/not/exist",
        "Error: nope/does/not/exist is not in the password store.\n",
      ),
    ).pipe(Effect.flip);
    expect(failure).toBeInstanceOf(SecretReadFailed);
    expect(failure).toMatchObject({ backend: "pass", ref: "nope/does/not/exist" });
  }),
);
