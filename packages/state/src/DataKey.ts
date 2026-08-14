import { Sh } from "@machine-run/core";
import { readSecret, type SecretError, type SecretSource } from "@machine-run/secrets";
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
  props: Omit<CommandRunProps, "command"> & { readonly command: Sh.ShellCommand },
) => Effect.Effect<{ exitCode: number; stdout: string; stderr: string }, CommandError>;

type CryptoService = typeof Crypto.Crypto.Service;

const KEYCHAIN_SERVICE = "machine-run-state";

/** Never put through the command string — see {@link persistDataKey}. */
const DATA_KEY_ENV_VAR = "MACHINE_RUN_STATE_KEY";

/**
 * Where this stack's data key lives in the keychain.
 *
 * The service and the account are separate fields rather than one
 * `service/account` string, so nothing has to agree on a separator or split it
 * back apart — a stack name containing `/` was previously ambiguous.
 */
const keychainSource = (stack: string): SecretSource => ({
  _tag: "Keychain",
  service: KEYCHAIN_SERVICE,
  account: stack,
});

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
 * Reads the per-stack key from the keychain without folding away *why* it
 * failed — {@link ensureDataKey} needs that distinction (a genuinely absent
 * entry versus every other failure) and {@link readDataKey} deliberately
 * discards it, so both are built on this rather than on each other.
 */
const readRawDataKey = (
  stack: string,
  exec: Exec,
): Effect.Effect<Redacted.Redacted<Uint8Array>, SecretError | Encoding.EncodingError> =>
  readSecret(keychainSource(stack), exec).pipe(Effect.flatMap(decodeKey));

/**
 * Reads the per-stack data key already in the keychain. Never creates one —
 * that is {@link ensureDataKey}'s job, called only from `set`. A plain read
 * is what `get` needs: manufacturing a key to satisfy a read would produce a
 * key that cannot decrypt anything already on disk, and would mask a
 * genuinely lost key behind a fresh, useless one.
 *
 * Every failure — a missing entry, a locked keychain, a momentarily busy
 * `security`, corrupt base64 — folds into one `DataKeyUnavailable` here,
 * because `get`'s caller (`EncryptedState.ts`'s `decodeRow`) treats all of
 * them identically: degrade the row to absent and log a warning. That
 * folding is exactly what must *not* happen before deciding whether to mint
 * a replacement key, which is why {@link ensureDataKey} reads through
 * {@link readRawDataKey} instead of this function.
 */
export const readDataKey = (
  stack: string,
  exec: Exec,
): Effect.Effect<Redacted.Redacted<Uint8Array>, DataKeyUnavailable> =>
  readRawDataKey(stack, exec).pipe(
    Effect.catch((cause) => Effect.fail(new DataKeyUnavailable({ stack, cause }))),
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
    // `-w` takes the key through `$MACHINE_RUN_STATE_KEY`, never inlined —
    // see the doc comment above. `Sh.sh`'s argv quoting cannot express that:
    // it would single-quote the `$`, and single quotes suppress exactly the
    // expansion this needs, so the reference is spliced in via `Sh.ref` and
    // the whole command is an explicit `Sh.unsafeRaw`.
    command: Sh.unsafeRaw(
      `${Sh.sh("security", "add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", stack)} -w ${Sh.ref(DATA_KEY_ENV_VAR)} -U`,
      "references $MACHINE_RUN_STATE_KEY via env so the key never enters the command string; Sh.sh's argv quoting would single-quote the $ and break the expansion",
    ),
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
 *
 * Minting is gated on `SecretNotFound` specifically — a genuine "no key yet"
 * signal, verified against the real keychain (see
 * `@machine-run/secrets`'s `backends/Keychain.ts`) — rather than on any read
 * failure. A locked keychain, "user interaction is not allowed" (the
 * headless case), or `security` being momentarily busy all surface as some
 * other `SecretError`, and must reach `set` as a `DataKeyUnavailable`
 * instead of being misread as "no key exists yet": minting in response would
 * persist a fresh key over the real one (`persistDataKey`'s `-U` updates in
 * place), permanently orphaning every row already encrypted under it. This
 * is the fix for that data-loss bug — see `MUST_CLEANUP.md` 0.1.
 */
export const ensureDataKey = (
  stack: string,
  exec: Exec,
  crypto: CryptoService,
): Effect.Effect<Redacted.Redacted<Uint8Array>, DataKeyUnavailable> =>
  readRawDataKey(stack, exec).pipe(
    Effect.catchTag("SecretNotFound", () =>
      Effect.gen(function* () {
        const raw = yield* crypto.randomBytes(KEY_BYTES);
        yield* persistDataKey(stack, Redacted.make(Encoding.encodeBase64(raw)), exec);
        return Redacted.make(raw);
      }),
    ),
    Effect.catch((cause) => Effect.fail(new DataKeyUnavailable({ stack, cause }))),
  );
