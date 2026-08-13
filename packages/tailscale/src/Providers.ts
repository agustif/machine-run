import * as Layer from "effect/Layer";
import { TailscaleConnectionProvider } from "./Connection.ts";

/**
 * Registers `Tailscale.Connection`.
 *
 * No secret-store layer is provided or required: secret backends are plain
 * values that receive a command runner when read, so this package depends on
 * the registry as a module import rather than as a service.
 */
export const providers = () => Layer.mergeAll(TailscaleConnectionProvider());
