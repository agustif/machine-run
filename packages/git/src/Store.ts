import { type CredentialHelperBackend, type CredentialHelperBackendId } from "./Backend.ts";
import { GhBackend } from "./backends/Gh.ts";
import { LibsecretBackend } from "./backends/Libsecret.ts";
import { OsxkeychainBackend } from "./backends/Osxkeychain.ts";

/** Every backend, keyed by id — the one place that has to know all of them. */
const backends = {
  osxkeychain: OsxkeychainBackend,
  libsecret: LibsecretBackend,
  gh: GhBackend,
} satisfies Record<CredentialHelperBackendId, CredentialHelperBackend>;

export const credentialHelperBackend = (id: CredentialHelperBackendId): CredentialHelperBackend =>
  backends[id];
