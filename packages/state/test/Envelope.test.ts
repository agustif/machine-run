import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Redacted from "effect/Redacted";
import { additionalData, decrypt, encrypt, EnvelopeDecryptFailed, KEY_BYTES } from "../src/Envelope.ts";

/** Resolved once: the real Node `Crypto` service, for `randomBytes`. */
const crypto = Effect.runSync(Crypto.Crypto.pipe(Effect.provide(NodeCrypto.layer)));
const randomBytes = crypto.randomBytes;

const genKey = Effect.gen(function* () {
  return Redacted.make(yield* randomBytes(KEY_BYTES));
});

/** Flips the envelope's last base64 character, corrupting the ciphertext (and its trailing GCM tag byte) without changing its length. */
const flipLastChar = (base64: string): string =>
  base64.slice(0, -1) + (base64.at(-1) === "A" ? "B" : "A");

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const fromUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

it.effect("round-trips: decrypting an encrypted value returns the original bytes", () =>
  Effect.gen(function* () {
    const key = yield* genKey;
    const aad = additionalData("stack-a", "dev", "MyResource");
    const plaintext = utf8(JSON.stringify({ hello: "world", n: 42 }));

    const envelope = yield* encrypt(key, aad, plaintext, randomBytes);
    const decrypted = yield* decrypt(key, aad, envelope);

    expect(fromUtf8(decrypted)).toBe(fromUtf8(plaintext));
  }),
);

/**
 * This is the test that actually proves the feature: encrypting a value that
 * contains a secret must not leave that secret readable in what gets written.
 */
it.effect("the plaintext secret is absent from the encrypted envelope", () =>
  Effect.gen(function* () {
    const key = yield* genKey;
    const secret = "sk-test-0123456789-do-not-log-me";
    const plaintext = utf8(JSON.stringify({ attr: { token: secret } }));

    const envelope = yield* encrypt(key, additionalData("s", "d", "f"), plaintext, randomBytes);

    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain(secret);
    // Guards against a weaker encoding (e.g. base64 of the plaintext itself)
    // slipping the secret through unnoticed under a different text encoding.
    expect(serialized).not.toContain(Encoding.encodeBase64(secret));
  }),
);

it.effect("a modified ciphertext fails to decrypt rather than returning garbage", () =>
  Effect.gen(function* () {
    const key = yield* genKey;
    const aad = additionalData("s", "d", "f");
    const envelope = yield* encrypt(key, aad, utf8("hello world"), randomBytes);

    const tampered = { ...envelope, ciphertext: flipLastChar(envelope.ciphertext) };
    const failure = yield* Effect.flip(decrypt(key, aad, tampered));

    expect(failure).toBeInstanceOf(EnvelopeDecryptFailed);
  }),
);

it.effect("a modified iv fails to decrypt rather than returning garbage", () =>
  Effect.gen(function* () {
    const key = yield* genKey;
    const aad = additionalData("s", "d", "f");
    const envelope = yield* encrypt(key, aad, utf8("hello world"), randomBytes);

    const tampered = { ...envelope, iv: flipLastChar(envelope.iv) };
    const failure = yield* Effect.flip(decrypt(key, aad, tampered));

    expect(failure).toBeInstanceOf(EnvelopeDecryptFailed);
  }),
);

it.effect("a row moved to a different resource (fqn) fails to decrypt", () =>
  Effect.gen(function* () {
    const key = yield* genKey;
    const envelope = yield* encrypt(
      key,
      additionalData("stack", "dev", "ResourceA"),
      utf8("hello world"),
      randomBytes,
    );

    // Same key (same stack), same stage, different fqn — exactly the "moved
    // between resources" scenario the additional authenticated data exists
    // to catch.
    const failure = yield* Effect.flip(
      decrypt(key, additionalData("stack", "dev", "ResourceB"), envelope),
    );

    expect(failure).toBeInstanceOf(EnvelopeDecryptFailed);
  }),
);

it.effect("a row moved to a different stage of the same stack fails to decrypt", () =>
  Effect.gen(function* () {
    const key = yield* genKey;
    const envelope = yield* encrypt(
      key,
      additionalData("stack", "dev", "SameName"),
      utf8("hello world"),
      randomBytes,
    );

    // The data key is per-stack, not per-stage (see `DataKey.ts`), so without
    // the stage folded into the AAD this would decrypt successfully under
    // the same key — exactly the loophole the AAD's stage component closes.
    const failure = yield* Effect.flip(
      decrypt(key, additionalData("stack", "prod", "SameName"), envelope),
    );

    expect(failure).toBeInstanceOf(EnvelopeDecryptFailed);
  }),
);

it.effect("a different key fails to decrypt", () =>
  Effect.gen(function* () {
    const key1 = yield* genKey;
    const key2 = yield* genKey;
    const aad = additionalData("s", "d", "f");
    const envelope = yield* encrypt(key1, aad, utf8("hello world"), randomBytes);

    const failure = yield* Effect.flip(decrypt(key2, aad, envelope));

    expect(failure).toBeInstanceOf(EnvelopeDecryptFailed);
  }),
);
