import type { SecretBackend, SecretBackendId } from "./Backend.ts";
import { DopplerBackend } from "./backends/Doppler.ts";
import { EnvBackend } from "./backends/Env.ts";
import { KeychainBackend } from "./backends/Keychain.ts";
import { OnePasswordBackend } from "./backends/OnePassword.ts";
import { PassBackend } from "./backends/Pass.ts";

/**
 * The registry of secret backends, keyed by id.
 *
 * This mirrors how `System.Package` dispatches to a package-manager backend:
 * one generic resource, one lookup, one small module per store. Adding a store
 * means writing `backends/<Name>.ts` and adding a line here — no resource
 * changes, and no new resource type.
 *
 * It is a plain record rather than a service because a backend is now a
 * value, not something built from an environment: `read` receives the command
 * runner it should use, so nothing here needs a `CommandExecutor` — or knows
 * which status session a command reports to.
 *
 * `bitwarden` is deliberately absent from `SecretBackendId` until it is
 * implemented; an id that can be named but not constructed is worse than a
 * missing one.
 */
export const secretBackends = {
  "1password": OnePasswordBackend,
  doppler: DopplerBackend,
  keychain: KeychainBackend,
  pass: PassBackend,
  env: EnvBackend,
} satisfies Record<SecretBackendId, SecretBackend>;

export const secretBackend = (id: SecretBackendId): SecretBackend =>
  secretBackends[id];
