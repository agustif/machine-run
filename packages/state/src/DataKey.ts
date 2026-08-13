import { Sh } from "@machine-run/core";
import { secretBackend, type SecretError } from "@machine-run/secrets";
import type { CommandError, CommandRunProps } from "alchemy/Command";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Redacted from "effect/Redacted";
import { KEY_BYTES } from "./Envelope.ts";

/**
 * A command runner with its status session already bound — structurally the
 * same as `@machine-run/engine`'s `Exec`. Declared locally instead of
 * depending on `engine` for one type: this package's only real dependencies
 * are `core` (`Sh`) and `secrets` (the `keychain` backend), and pulling in
 * `engine` just for a type alias would suggest a dependency that isn't there
 * — see this package's `TASKS.md` for the fuller dependency-direction note.
 */
export type Exec = (
  props: CommandRunProps,
) => Effect.Effect<{ exitCode: number; stdout: string; stderr: string }, CommandError>;

type CryptoService = typeof Crypto.Crypto.Service;

const KEYCHAIN_SERVICE = "machine-run-state";

/** Never put through the command string — see {@link persistDataKey}. */
const DATA_KEY_ENV_VAR = "MACHINE_RUN_STATE_KEY";

const keychainRef = (stack: string): string => `${KEYCHAIN_SERVICE}/${stack}`;

/**
 * Storing a newly generated key in the keychain failed. Only reachable from
 * {@link ensureDataKey}'s generate branch — a plain {@link readDataKey} never
 * writes anything.
 */
export class DataKeyPersistFailed extends Data.TaggedError("DataKeyPersistFailed")<{
  stack: string;
  cause: CommandError;
}> {
  override get message() {
    return `Could not store a newly generated state-encryption key for stack "${this.stack}" in the keychain.`;
  }
}

/**
 * No usable data key for this stack: missing from the keychain, corrupt, or
 * — only via {@link ensureDataKey} — unwritable. `EncryptedState.ts` degrades
 * every occurrence of this from `get` to "treat the row as absent"; from
 * `set` it surfaces as a `StateStoreError`, since there nothing was lost —
 * see this package's `TASKS.md` for why those two calls warrant different
 * treatment.
 */
export class DataKeyUnavailable extends Data.TaggedError("DataKeyUnavailable")<{
  stack: string;
  cause: unknown;
}> {
  override get message() {
    return `No usable state-encryption key for stack "${this.stack}".`;
  }
}

const decodeKey = (
  encoded: Redacted.Redacted<string>,
): Effect.Effect<Redacted.Redacted<Uint8Array>, Encoding.EncodingError> =>
  Effect.fromResult(Encoding.decodeBase64(Redacted.value(encoded))).pipe(Effect.map(Redacted.make));

/**
 * Reads the per-stack data key already in the keychain. Never creates one —
 * that is {@link ensureDataKey}'s job, called only from `set`. A plain read
 * is what `get` needs: manufacturing a key to satisfy a read would produce a
 * key that cannot decrypt anything already on disk, and would mask a
 * genuinely lost key behind a fresh, useless one.
 */
export const readDataKey = (
  stack: string,
  exec: Exec,
): Effect.Effect<Redacted.Redacted<Uint8Array>, DataKeyUnavailable> =>
  secretBackend("keychain")
    .read(keychainRef(stack), exec)
    .pipe(
      Effect.flatMap(decodeKey),
      Effect.catch((cause: SecretError | Encoding.EncodingError) =>
        Effect.fail(new DataKeyUnavailable({ stack, cause })),
      ),
    );

/**
 * Writes the stack's data key to the keychain, updating it in place if a
 * concurrent run already created one (`-U`) rather than failing with
 * "already exists".
 *
 * The key reaches `security` through `env` as a `Redacted` value, never
 * interpolated into the command string — AGENTS.md #9, and the same pattern
 * `Tailscale.Connection` uses for `TS_AUTHKEY`. An interpolated key would be
 * visible in `ps` output and in any `CommandError` message; Alchemy's
 * redactor only scrubs values passed this way.
 */
const persistDataKey = (
  stack: string,
  key: Redacted.Redacted<string>,
  exec: Exec,
): Effect.Effect<void, DataKeyPersistFailed> =>
  exec({
    command: `${Sh.sh("security", "add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", stack)} -w "$${DATA_KEY_ENV_VAR}" -U`,
    shell: true,
    env: { [DATA_KEY_ENV_VAR]: key },
  }).pipe(
    Effect.asVoid,
    Effect.catch((cause) => Effect.fail(new DataKeyPersistFailed({ stack, cause }))),
  );

/**
 * Reads the per-stack key, generating and persisting a new one on first use.
 *
 * Called only from `set`. The caller (`EncryptedState.ts`) is expected to
 * memoise this per stack: every concurrent `set` for a stack with no key yet
 * would otherwise race to generate and overwrite a *different* random key —
 * Alchemy applies with `concurrency: "unbounded"` — leaving earlier rows in
 * the same run encrypted under a key the last write clobbered.
 */
export const ensureDataKey = (
  stack: string,
  exec: Exec,
  crypto: CryptoService,
): Effect.Effect<Redacted.Redacted<Uint8Array>, DataKeyUnavailable> =>
  readDataKey(stack, exec).pipe(
    Effect.catch(() =>
      Effect.gen(function* () {
        const raw = yield* crypto
          .randomBytes(KEY_BYTES)
          .pipe(Effect.catch((cause) => Effect.fail(new DataKeyUnavailable({ stack, cause }))));
        yield* persistDataKey(stack, Redacted.make(Encoding.encodeBase64(raw)), exec).pipe(
          Effect.catch((cause) => Effect.fail(new DataKeyUnavailable({ stack, cause }))),
        );
        return Redacted.make(raw);
      }),
    ),
  );
