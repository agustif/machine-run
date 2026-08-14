import type { Exec } from "@machine-run/engine";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import type * as Redacted from "effect/Redacted";
import type { SecretError, SecretSource } from "./Backend.ts";
import { DopplerBackend } from "./backends/Doppler.ts";
import { EnvBackend } from "./backends/Env.ts";
import { KeychainBackend } from "./backends/Keychain.ts";
import { OnePasswordBackend } from "./backends/OnePassword.ts";
import { PassBackend } from "./backends/Pass.ts";

/**
 * Resolves a {@link SecretSource} to its value, dispatching on its `_tag` to
 * the one backend that knows that store's addressing scheme.
 *
 * This mirrors how `System.Package` dispatches to a package-manager backend:
 * one generic resource, one small module per store. It used to be a plain
 * record keyed by a string id (`secretBackends[props.source]`), which worked
 * because every backend shared one `read(ref: string, exec)` signature. Now
 * that each backend's `read` is narrowed to the one `SecretSource` variant it
 * understands, a record lookup can no longer type-check — the lookup would
 * have to hand every backend the same union type, which is exactly the
 * un-narrowed shape this whole change exists to avoid. `Match.tagsExhaustive`
 * dispatches instead: it narrows `source` to each variant before handing it
 * to that variant's backend, and — this is the actual point — adding a sixth
 * `SecretSource` case without adding a case here is a compile error, not a
 * silent `undefined` lookup at runtime.
 *
 * `bitwarden` is deliberately absent from `SecretSource` until it is
 * implemented; an id that can be named but not constructed is worse than a
 * missing one.
 */
export const readSecret = (
  source: SecretSource,
  exec: Exec,
): Effect.Effect<Redacted.Redacted<string>, SecretError> =>
  Match.value(source).pipe(
    Match.tagsExhaustive({
      OnePassword: (s) => OnePasswordBackend.read(s, exec),
      Doppler: (s) => DopplerBackend.read(s, exec),
      Keychain: (s) => KeychainBackend.read(s, exec),
      Pass: (s) => PassBackend.read(s, exec),
      Env: (s) => EnvBackend.read(s, exec),
    }),
  );
