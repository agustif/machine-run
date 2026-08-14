import type { Exec } from "@machine-run/engine";
import { CommandError, UnexpectedExit } from "alchemy/Command";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { DopplerBackend } from "../src/backends/Doppler.ts";
import { SecretAuthRequired, type SecretSource } from "../src/Backend.ts";

const failingExec =
  (command: string, stderr: string): Exec =>
  () =>
    Effect.fail(new CommandError({ command, reason: new UnexpectedExit({ exitCode: 1, stderr }) }));

const source: Extract<SecretSource, { _tag: "Doppler" }> = {
  _tag: "Doppler",
  project: "someproj",
  config: "someconfig",
  name: "SOME_SECRET",
};

it.effect("DopplerBackend.read classifies a real no-token `doppler` as SecretAuthRequired", () =>
  Effect.gen(function* () {
    // Real captured `doppler secrets get SOME_SECRET --plain --project
    // someproj --config someconfig` stderr, Doppler CLI v3.76.4 installed
    // from the official apt repo, no DOPPLER_TOKEN set and never logged
    // in. Before this session, `classify` only matched "unauthorized" /
    // "invalid auth token", neither of which appears here, so this real
    // and arguably most common "never configured" state used to fall
    // through to the generic SecretReadFailed bucket instead. See
    // docs/notes/secrets-doppler-notes.md and
    // packages/secrets/test/fixtures/doppler-no-token-stderr.txt.
    const failure = yield* DopplerBackend.read(
      source,
      failingExec(
        "doppler secrets get SOME_SECRET --plain --project someproj --config someconfig",
        "Doppler Error: you must provide a token\n",
      ),
    ).pipe(Effect.flip);
    expect(failure).toBeInstanceOf(SecretAuthRequired);
    expect(failure).toMatchObject({ source, signInCommand: "doppler login" });
  }),
);

it.effect(
  "DopplerBackend.read classifies a real invalid-token `doppler` as SecretAuthRequired",
  () =>
    Effect.gen(function* () {
      // Real captured stderr with a syntactically plausible but fake
      // DOPPLER_TOKEN set — this one already matched the pre-existing
      // "invalid auth token" substring, confirming that half of the
      // classifier was correct before this session, not merely plausible.
      // See packages/secrets/test/fixtures/doppler-invalid-token-stderr.txt.
      const failure = yield* DopplerBackend.read(
        source,
        failingExec(
          "doppler secrets get SOME_SECRET --plain --project someproj --config someconfig",
          "Unable to fetch secrets\nDoppler Error: Invalid Auth token\n",
        ),
      ).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(SecretAuthRequired);
      expect(failure).toMatchObject({ source, signInCommand: "doppler login" });
    }),
);
