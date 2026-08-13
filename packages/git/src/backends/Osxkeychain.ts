import type { CredentialHelperBackend } from "./Backend.ts";

/**
 * The macOS login keychain.
 *
 * Verified present on this machine: `git-credential-osxkeychain` ships
 * alongside git itself (found via `git --exec-path`, on Apple's Command Line
 * Tools git 2.50.1), so the bare name is all `credential.helper` needs — git
 * resolves it to `git-credential-osxkeychain` on `PATH`/`git --exec-path`
 * without any absolute path.
 */
export const OsxkeychainBackend: CredentialHelperBackend = {
  id: "osxkeychain",
  values: ["osxkeychain"],
};
