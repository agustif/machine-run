import type { CredentialHelperBackend } from "../Backend.ts";

/**
 * The Linux Secret Service (GNOME Keyring, KWallet via a compatible provider,
 * etc.) via `git-credential-libsecret`.
 *
 * Verified in containers, and it genuinely varies by distro:
 *
 * - **Fedora** (`dnf install git-credential-libsecret`) ships a ready
 *   binary at `/usr/libexec/git-core/git-credential-libsecret` (confirmed
 *   again in this session on `fedora:latest`, git 2.55.0 — a real
 *   69072-byte executable, already on git's own exec-path).
 * - **Debian/Ubuntu 24.04**'s `git` package ships only the *source*
 *   (`/usr/share/doc/git/contrib/credential/libsecret/git-credential-
 *   libsecret.c`) and a `Makefile` to build it against `libsecret-1-dev` +
 *   `libglib2.0-dev` — there is no apt package that installs a working
 *   binary. This backend does not build it: machine-run doesn't compile C
 *   code as a side effect of wiring up config, so on Debian/Ubuntu the value
 *   below is set correctly but resolves to nothing on `PATH` until a human
 *   (or a future `System.Package`/build step) produces the binary. **This is
 *   the sharpest edge of this backend**: a recipe naming `libsecret` on such
 *   a machine fails at *use time* (the next `git push`/`git credential fill`
 *   prompting or erroring instead of using the helper), never at `apply`
 *   time — `Git.CredentialHelper` has no way to check for the binary's
 *   existence as part of convergence, only to write the literal string git
 *   should look up.
 *
 * The bare name is used regardless of distro, on the same reasoning as
 * `osxkeychain`: once the binary exists anywhere on `PATH`, git finds it
 * without an absolute path, and hard-coding one distro's install location
 * would be wrong for every other.
 *
 * **Config round trip and real dispatch, verified on Fedora** (`docker run
 * --rm fedora:latest`, `dnf install --setopt=install_weak_deps=False
 * --setopt=tsflags=nodocs git git-credential-libsecret dbus-x11
 * gnome-keyring`): `git config --global credential.helper libsecret` then
 * `git config --global --get-all credential.helper` round-trips the value,
 * and `GIT_TRACE=1 git credential fill` shows git genuinely executing the
 * real binary — `run_command: 'git credential-libsecret get'` → `exec:
 * git-credential-libsecret get` → `start_command:
 * /usr/libexec/git-core/git-credential-libsecret get`.
 *
 * **The end-to-end store/fetch round trip (a real Secret Service session)
 * could not be completed in this session's containers**, and the reasons are
 * themselves worth recording rather than glossed over:
 *
 * 1. In a plain unprivileged `docker run`, `git-credential-libsecret` prints
 *    `could not connect to Secret Service: Cannot spawn a message bus
 *    without a machine-id: Invalid machine ID in /var/lib/dbus/machine-id or
 *    /etc/machine-id` — the base image has no machine-id at all.
 * 2. Generating one (`dbus-uuidgen > /etc/machine-id`) gets past that, but
 *    `gnome-keyring-daemon --unlock --components=secrets --daemonize` then
 *    fails itself: `error dropping process capabilities - -5, aborting` —
 *    blocked by the container's own capability restrictions, not by
 *    anything wrong with git or this backend's config value.
 * 3. Re-running `--privileged` clears both of those, and the Secret Service
 *    now starts — but `git credential approve` then fails differently:
 *    `store failed: Object does not exist at path
 *    "/org/freedesktop/secrets/collection/login"`. `gnome-keyring-daemon`
 *    only materialises the default "login" collection through a fuller
 *    session/PAM-unlock flow than `--unlock` with an empty stdin password
 *    provides headlessly; this is a keyring-provisioning gap in the test
 *    container, not evidence against the config value or the dispatch path
 *    above, both of which are independently confirmed.
 *
 * Net effect, stated plainly: the config value and git's resolution/dispatch
 * of it are `✓`; the actual credential-store round trip stays unverified,
 * for the three concrete, escalating reasons above rather than an assumption
 * that "a container can't do this."
 */
export const LibsecretBackend: CredentialHelperBackend = {
  id: "libsecret",
  values: ["libsecret"],
};
