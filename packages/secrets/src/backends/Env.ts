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
