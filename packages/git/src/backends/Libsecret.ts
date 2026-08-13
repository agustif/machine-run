import type { CredentialHelperBackend } from "./Backend.ts";

/**
 * The Linux Secret Service (GNOME Keyring, KWallet via a compatible provider,
 * etc.) via `git-credential-libsecret`.
 *
 * Verified in containers, and it genuinely varies by distro:
 *
 * - **Fedora** (`dnf install git-credential-libsecret`) ships a ready
 *   binary at `/usr/libexec/git-core/git-credential-libsecret`, already on
 *   git's own exec-path — the bare name resolves immediately.
 * - **Debian/Ubuntu 24.04**'s `git` package ships only the *source*
 *   (`/usr/share/doc/git/contrib/credential/libsecret/git-credential-
 *   libsecret.c`) and a `Makefile` to build it against `libsecret-1-dev` +
 *   `libglib2.0-dev` — there is no apt package that installs a working
 *   binary. This backend does not build it: machine-run doesn't compile C
 *   code as a side effect of wiring up config, so on Debian/Ubuntu the value
 *   below is set correctly but resolves to nothing on `PATH` until a human
 *   (or a future `System.Package`/build step) produces the binary.
 *
 * The bare name is used regardless of distro, on the same reasoning as
 * `osxkeychain`: once the binary exists anywhere on `PATH`, git finds it
 * without an absolute path, and hard-coding one distro's install location
 * would be wrong for every other.
 */
export const LibsecretBackend: CredentialHelperBackend = {
  id: "libsecret",
  values: ["libsecret"],
};
