import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import type * as PlatformError from "effect/PlatformError";

/**
 * A SHA-256 function with its crypto implementation already resolved.
 *
 * Content hashes are how the file-shaped resources decide whether what is on
 * disk matches what a recipe asks for, so hashing sits on the hot path of every
 * plan and every reconciler needs it.
 *
 * Effect's `Crypto` service is used rather than the `crypto` global, so the
 * digest is a substitutable dependency with a typed failure channel instead of
 * whatever `globalThis` happens to expose. `@effect/platform-node`'s
 * `NodeServices` provides it, alongside `FileSystem` and `Path`.
 *
 * The service is resolved **once, here**, and a plain function handed back.
 * Requiring `Crypto` from every call site instead would push it into the
 * requirements of every `observe` and `desired` — and a `Reconciler`'s methods
 * are deliberately requirement-free, since the engine resolves everything a
 * resource needs when it builds the reconciler, not per reconcile.
 */
export const makeSha256: Effect.Effect<
  (input: string) => Effect.Effect<string, PlatformError.PlatformError>,
  never,
  Crypto.Crypto
> = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  return (input: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(input)).pipe(Effect.map(Encoding.encodeHex));
});
