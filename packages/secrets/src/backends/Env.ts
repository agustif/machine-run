import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import {
  type SecretBackend,
  SecretReadFailed,
  SecretRefInvalid,
  type SecretSource,
} from "../Backend.ts";

type EnvSource = Extract<SecretSource, { _tag: "Env" }>;

/**
 * Reads a secret from the reconciler's own environment.
 *
 * `variable` is a plain environment variable name, e.g. `GITHUB_TOKEN`.
 *
 * This is the escape hatch that keeps `Machine.SecretFile` usable without any
 * particular vendor's CLI: CI runners, systemd credentials, a cloud instance's
 * metadata agent and `direnv` all deliver secrets this way. It needs no
 * `CommandExecutor` at all.
 *
 * It is not a way to smuggle a literal into a recipe. The value is read at
 * reconcile time from the process environment and, like every other backend,
 * never enters Alchemy's state.
 *
 * Reads go through `Config.redacted` rather than `process.env` directly, so
 * the value arrives already `Redacted` — it cannot be accidentally logged or
 * interpolated into a command string on its way to being written — and so the
 * lookup honours whatever `ConfigProvider` is in scope instead of hard-coding
 * one source.
 *
 * Verified against a real, unmocked default `ConfigProvider` — no
 * `ConfigProvider.fromEnvRecord`/`fromEnv({ env })` override — inside
 * `docker run --rm -e MACHINE_RUN_TEST_SECRET=sup3rEnvSecret node:22-slim`,
 * running this repo's pinned `effect@4.0.0-rc.108`: `Config.redacted` for a
 * variable set that way round-tripped the exact literal value through
 * `Redacted.value`, and a variable never set failed with a real
 * `ConfigError` (not a `CommandError` — there is no command here to fail).
 * `Effect.catch` above catches that unconditionally regardless of its tag or
 * shape, so there is no substring classifier to get wrong the way the
 * CLI-backed backends have. See `docs/notes/secrets-env-notes.md` and
 * `packages/secrets/test/fixtures/env-real-container-run.txt` for the full
 * session, including why the container sets the variable before `node`
 * starts rather than mutating `process.env` mid-script: `effect`'s default
 * `ConfigProvider` snapshots `process.env` once, on first access, for the
 * process's lifetime (independently verified elsewhere in this repo —
 * `packages/git/test/Config.test.ts`, `packages/ai/test/McpServer.test.ts` —
 * by reading `effect`'s own `ConfigProvider.fromEnv` source), so a variable
 * set after that first access is invisible to this backend for the rest of
 * that process. That is not a concern for `Machine.SecretFile`'s own usage,
 * which resolves a recipe's secret once per `apply`, but it does mean this
 * backend cannot observe an environment variable changing underneath a
 * long-lived process.
 */
export const EnvBackend: SecretBackend<EnvSource> = {
  id: "Env",
  read: (source) =>
    Effect.gen(function* () {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(source.variable)) {
        return yield* Effect.fail(
          new SecretRefInvalid({
            source,
            expected: "an environment variable name, e.g. GITHUB_TOKEN",
          }),
        );
      }
      return yield* Config.redacted(source.variable).pipe(
        Effect.catch(() =>
          Effect.fail(
            // No command ran, so there is no CommandError to attribute this
            // to; the variable simply is not set for this process.
            new SecretReadFailed({ source, cause: undefined }),
          ),
        ),
      );
    }),
};
