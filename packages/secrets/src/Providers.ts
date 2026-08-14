import * as Layer from "effect/Layer";
import { SecretFileProvider } from "./SecretFile.ts";

/**
 * Registers `Machine.SecretFile`.
 *
 * There is no secret-store layer to provide: backends are plain values that
 * receive a command runner when read, so the registry needs no environment of
 * its own. A package that reads secrets for its own purposes — `tailscale`
 * needs an auth key — imports `readSecret` from `Store.ts` directly.
 */
export const providers = () => Layer.mergeAll(SecretFileProvider());
