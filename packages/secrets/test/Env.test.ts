import type { Exec } from "@machine-run/engine";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { EnvBackend } from "../src/backends/Env.ts";
import { SecretReadFailed, SecretRefInvalid } from "../src/Backend.ts";

/** `EnvBackend.read` never calls `exec` — a stub that dies if it ever is keeps that honest. */
const neverExec: Exec = () => Effect.die("EnvBackend must never call exec");

/**
 * `EnvBackend.read` has no CLI to shell out to — it reads
 * `Config.redacted(variable)` from whatever `ConfigProvider` is in scope,
 * defaulting to `ConfigProvider.fromEnv()` (i.e. the real OS `process.env`)
 * when nothing overrides it. `SecretFile.test.ts` and `Store.test.ts` both
 * already exercise this backend for real, but always via an explicit
 * `ConfigProvider.fromEnvRecord({...})` override — never the actual default
 * provider reading the actual process environment.
 *
 * This session closed that gap by running, in a fresh `docker run --rm -e
 * MACHINE_RUN_TEST_SECRET=sup3rEnvSecret node:22-slim` container (this
 * repo's pinned `effect@4.0.0-rc.108`, no `ConfigProvider` override
 * anywhere in the script), `Config.redacted` against a variable set that
 * way, before `node` ever started: it round-tripped the exact literal value
 * through `Redacted.value`, and a variable never set failed with a real
 * `ConfigError`. See docs/notes/secrets-env-notes.md and
 * packages/secrets/test/fixtures/env-real-container-run.txt for the full
 * session, including why that verification had to run in a fresh process
 * rather than as an in-process vitest test: `effect`'s default
 * `ConfigProvider` snapshots `process.env` once, on first access, for the
 * process's lifetime (independently verified elsewhere in this repo —
 * packages/git/test/Config.test.ts, packages/ai/test/McpServer.test.ts), so
 * mutating `process.env` mid-test here would not reliably exercise it.
 *
 * The tests below use `ConfigProvider.fromEnv({ env })` rather than
 * `fromEnvRecord` — the exact function the true zero-argument default
 * (`ConfigProvider.fromEnv()`) delegates to once it has read `process.env`,
 * parameterized here with an explicit record instead, so this exercises the
 * identical real decode path the container run confirmed, deterministically
 * and independent of test order.
 */
const withEnv = <A, E, R>(vars: Record<string, string>, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: vars })));

it.effect("EnvBackend.read returns the real value for a variable that is set", () =>
  Effect.gen(function* () {
    const value = yield* withEnv(
      { MACHINE_RUN_TEST_SECRET: "sup3rEnvSecret" },
      EnvBackend.read({ _tag: "Env", variable: "MACHINE_RUN_TEST_SECRET" }, neverExec),
    );
    expect(Redacted.value(value)).toBe("sup3rEnvSecret");
  }),
);

it.effect("EnvBackend.read surfaces an unset variable as SecretReadFailed", () =>
  Effect.gen(function* () {
    const failure = yield* withEnv(
      {},
      EnvBackend.read({ _tag: "Env", variable: "MACHINE_RUN_TEST_SECRET_DOES_NOT_EXIST" }, neverExec),
    ).pipe(Effect.flip);
    expect(failure).toBeInstanceOf(SecretReadFailed);
    expect(failure).toMatchObject({
      source: { _tag: "Env", variable: "MACHINE_RUN_TEST_SECRET_DOES_NOT_EXIST" },
      cause: undefined,
    });
  }),
);

it.effect("EnvBackend.read rejects a variable name that isn't a valid shell identifier", () =>
  Effect.gen(function* () {
    const failure = yield* withEnv(
      { "123-not-an-identifier": "irrelevant" },
      EnvBackend.read({ _tag: "Env", variable: "123-not-an-identifier" }, neverExec),
    ).pipe(Effect.flip);
    expect(failure).toBeInstanceOf(SecretRefInvalid);
  }),
);
