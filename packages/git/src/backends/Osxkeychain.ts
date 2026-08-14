import type { CredentialHelperBackend } from "../Backend.ts";

/**
 * The macOS login keychain.
 *
 * Verified present on this machine: `git-credential-osxkeychain` ships
 * alongside git itself (`ls $(git --exec-path)` on Apple's Command Line Tools
 * git 2.50.1 shows a real, executable 123280-byte binary at
 * `/Library/Developer/CommandLineTools/usr/libexec/git-core/
 * git-credential-osxkeychain`), so the bare name is all `credential.helper`
 * needs.
 *
 * Dispatch verified too, without touching the real `~/.gitconfig` or reading
 * any real credential: `GIT_TRACE=1 git -c credential.helper=osxkeychain
 * credential fill` (a transient, in-process override — nothing written to
 * disk) against a host guaranteed absent from this machine's real keychain
 * (`verify.machine-run-nonexistent.invalid`) shows git resolving and actually
 * executing the real binary — `run_command: 'git credential-osxkeychain
 * get'` then `exec: git-credential-osxkeychain get` then `start_command:
 * .../git-credential-osxkeychain get`. The lookup correctly finds nothing (no
 * such entry exists) and git falls through to its own interactive
 * username/password prompt, which fails on `Device not configured` only
 * because this check ran with no controlling tty — not because the helper or
 * the config value is wrong. This machine's real global `credential.helper`
 * was never read or written (`git config --global --get-all
 * credential.helper` confirms it stays unset); the actual `--global
 * credential.helper osxkeychain` round trip was not repeated against a real
 * file for the same reason — the `-c` form exercises the identical git
 * config-parsing and dispatch code path.
 */
export const OsxkeychainBackend: CredentialHelperBackend = {
  id: "osxkeychain",
  values: ["osxkeychain"],
};
