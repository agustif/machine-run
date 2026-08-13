import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import type * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/**
 * The on-disk shape of one encrypted row.
 *
 * `__machineRunEncrypted__` is a marker key in the same spirit as Alchemy's
 * own `__redacted__`/`__duration__`/`__date__` (`alchemy/State/StateEncoding`)
 * — a JSON row carrying it is unambiguously ours, never mistaken for a plain
 * `PersistedState`, and a human inspecting `.alchemy/state/*.json` by hand can
 * tell at a glance that a resource's state is opaque rather than missing.
 * `ciphertext` includes the GCM authentication tag: `SubtleCrypto.encrypt`
 * appends it to the returned buffer, so there is nothing to store separately.
 */
export const Envelope = Schema.Struct({
  __machineRunEncrypted__: Schema.Literal(1),
  iv: Schema.String,
  ciphertext: Schema.String,
});

export type Envelope = typeof Envelope.Type;

export const ENVELOPE_VERSION = 1 as const;

/** AES-256 key material, in bytes. */
export const KEY_BYTES = 32;

/** GCM's recommended IV length, in bytes. */
const IV_BYTES = 12;

/** GCM's authentication tag length, in bits. */
const TAG_BITS = 128;

/**
 * A row failed to encrypt. Always a bug or an exhausted entropy source, never
 * an expected outcome — unlike {@link EnvelopeDecryptFailed}, callers do not
 * degrade this away.
 */
export class EnvelopeEncryptFailed extends Data.TaggedError("EnvelopeEncryptFailed")<{
  cause: unknown;
}> {
  override get message() {
    return "Failed to encrypt a state row.";
  }
}

/**
 * A row failed to decrypt. AES-GCM's authentication tag makes this the
 * expected — and only — outcome for a modified ciphertext or one moved to a
 * different resource, stage, or stack (see {@link additionalData}): the tag
 * check fails before any plaintext is returned, so there is no such thing as
 * "decrypted, but wrong". Callers degrade this to "not in state" rather than
 * raising it — see `EncryptedState.ts`.
 */
export class EnvelopeDecryptFailed extends Data.TaggedError("EnvelopeDecryptFailed")<{
  cause: unknown;
}> {
  override get message() {
    return "Failed to decrypt a state row — wrong key, damaged ciphertext, or moved to a different resource.";
  }
}

/**
 * Binds an encrypted row to the identity it was encrypted for, as GCM
 * additional authenticated data. The envelope's data key is per-*stack* (see
 * `DataKey.ts`), so a stage and an fqn alone would not stop a row copied from
 * one stage of the same stack to another with a matching fqn from decrypting
 * successfully — the AAD folds in all three, null-separated so
 * `("a", "b/c")` and `("a/b", "c")` cannot collide.
 */
export const additionalData = (stack: string, stage: string, fqn: string): Uint8Array =>
  new TextEncoder().encode(`${stack}\0${stage}\0${fqn}`);

/**
 * Effect's platform-agnostic `Crypto` service has no AES-GCM primitive —
 * verified against `effect/src/Crypto.ts`, which offers only `digest` and
 * `randomBytes` — so there is no service call this could route through
 * instead. Effect's own `effect/unstable/eventlog/EventLogEncryption.ts` hits
 * the identical gap and resolves it the same way: `SubtleCrypto` from the
 * WebCrypto global (available on `globalThis` in Node without importing
 * `node:crypto`), used only for the AES-GCM primitive itself. Randomness
 * still comes from Effect's `Crypto` service — the IV here, and the key in
 * `DataKey.ts` — matching `noGlobals`'s own carve-out: it bans
 * `crypto.getRandomValues`/`crypto.randomUUID`/`crypto.subtle.digest` in
 * favour of `Crypto`, but does not ban `crypto.subtle.encrypt/decrypt/
 * importKey`, for which `Crypto` has no equivalent.
 */
// No explicit return type: `CryptoKey` is only reachable as `webcrypto.CryptoKey`
// via `node:crypto` in `@types/node` (this project has no "dom" lib), so the
// type is left to flow from `SubtleCrypto.importKey`'s own signature instead
// of naming it.
const importKey = (raw: Uint8Array, usage: "encrypt" | "decrypt") =>
  globalThis.crypto.subtle.importKey("raw", raw, "AES-GCM", false, [usage]);

/**
 * Encrypts one row's plaintext under the stack's data key.
 *
 * `randomBytes` is Effect's `Crypto.randomBytes`, handed in as a plain
 * function rather than required as a service — the same shape
 * `@machine-run/core`'s `hash.ts` resolves `Crypto` into, so this module stays
 * free of Effect's context machinery and is trivial to call from a plain
 * test.
 */
export const encrypt = (
  key: Redacted.Redacted<Uint8Array>,
  aad: Uint8Array,
  plaintext: Uint8Array,
  randomBytes: (size: number) => Effect.Effect<Uint8Array, PlatformError.PlatformError>,
): Effect.Effect<Envelope, EnvelopeEncryptFailed> =>
  Effect.gen(function* () {
    const iv = yield* randomBytes(IV_BYTES).pipe(
      Effect.catch((cause) => Effect.fail(new EnvelopeEncryptFailed({ cause }))),
    );
    const cryptoKey = yield* Effect.tryPromise({
      try: () => importKey(Redacted.value(key), "encrypt"),
      catch: (cause) => new EnvelopeEncryptFailed({ cause }),
    });
    const ciphertext = yield* Effect.tryPromise({
      try: () =>
        globalThis.crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: aad, tagLength: TAG_BITS },
          cryptoKey,
          plaintext,
        ),
      catch: (cause) => new EnvelopeEncryptFailed({ cause }),
    });
    return {
      __machineRunEncrypted__: ENVELOPE_VERSION,
      iv: Encoding.encodeBase64(iv),
      ciphertext: Encoding.encodeBase64(new Uint8Array(ciphertext)),
    };
  });

/**
 * Decrypts one row, verifying it was encrypted for exactly this `aad`.
 *
 * Every failure mode — a corrupt base64 field, a wrong key, a modified
 * ciphertext, a tampered tag, an `aad` mismatch from a row moved between
 * resources — surfaces as the same {@link EnvelopeDecryptFailed}. That is
 * deliberate: AES-GCM does not distinguish "wrong key" from "tampered" from
 * "wrong resource", and a caller that tried to tell them apart from the
 * exception alone would be inventing a distinction the primitive doesn't make.
 */
export const decrypt = (
  key: Redacted.Redacted<Uint8Array>,
  aad: Uint8Array,
  envelope: Envelope,
): Effect.Effect<Uint8Array, EnvelopeDecryptFailed> =>
  Effect.gen(function* () {
    const iv = yield* Effect.fromResult(Encoding.decodeBase64(envelope.iv)).pipe(
      Effect.catch((cause) => Effect.fail(new EnvelopeDecryptFailed({ cause }))),
    );
    const ciphertext = yield* Effect.fromResult(Encoding.decodeBase64(envelope.ciphertext)).pipe(
      Effect.catch((cause) => Effect.fail(new EnvelopeDecryptFailed({ cause }))),
    );
    const cryptoKey = yield* Effect.tryPromise({
      try: () => importKey(Redacted.value(key), "decrypt"),
      catch: (cause) => new EnvelopeDecryptFailed({ cause }),
    });
    const plaintext = yield* Effect.tryPromise({
      try: () =>
        globalThis.crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad, tagLength: TAG_BITS },
          cryptoKey,
          ciphertext,
        ),
      catch: (cause) => new EnvelopeDecryptFailed({ cause }),
    });
    return new Uint8Array(plaintext);
  });
