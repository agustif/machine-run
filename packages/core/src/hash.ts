import * as Effect from "effect/Effect";

/**
 * Hex-encoded SHA-256 digest of a string, used by dotfiles resources to
 * decide whether on-disk content already matches desired content.
 *
 * `crypto.subtle.digest` is genuinely async, so this is lifted via
 * `Effect.promise` (the same approach alchemy's own `Util/sha256.ts` uses)
 * rather than wrapped in `Effect.sync`, which is reserved for sync-only APIs.
 */
export const sha256 = (input: string) =>
  Effect.promise(async () => {
    const bytes = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  });
