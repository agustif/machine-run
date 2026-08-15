# git package notes

Working notes for `@machine-run/git` and the `@machine-run/git-identity`
shim it replaces. Not a doc-comment substitute — see the source files
themselves (`packages/git/src/*.ts`) for the load-bearing reasoning. This is
the cross-cutting stuff that doesn't belong in any one file's comment.

## `git-identity` should be removed before 1.0

> **RESOLVED since this note was written.** The package has been deleted.

`packages/git-identity` is now a thin re-export of `@machine-run/git`'s
`gitIdentity`/`GitPersonaProps` (`packages/git-identity/src/Identity.ts`).
It exists only so `examples/example-machine`'s two recipes
(`alchemy.run.ts`, `alchemy.container.ts`) keep compiling and running
unchanged. Once those are updated to import `@machine-run/git` directly,
delete `packages/git-identity` entirely and drop it from the root
`tsconfig.json`/`tsconfig.tests.json` reference lists.

Two backward-compatibility shims are living in `@machine-run/git` purely for
this reason and should go with it:

- `GitPersonaProps.gitconfigPath` — accepted but unused (`Config` always
  writes the one global scope, so there is no longer a file path to choose).
  Both example recipes still pass it.
- Nothing else needed a shim: neither example recipe passes `after`, so its
  type changing from a single `hash: string` (the old `Dotfiles.ManagedBlock`
  shape) to `values: readonly string[]` (the new `Config` shape) doesn't break
  either call site — but the *comment* in `alchemy.run.ts` still says
  `after: broad.gitconfigInclude.hash`, which is now stale. Whoever updates
  that recipe should fix the comment too; it's outside this package's scope
  to edit `examples/`.

## Known gap: `Config`'s `address` is a heuristic, not a guarantee

`Config`'s `address` (used for the shared `FileLock` and the pre-write
`Backups.snapshot`) resolves once, at reconciler build time, to whichever of
`~/.gitconfig` / `$XDG_CONFIG_HOME/git/config` (or `~/.config/git/config`)
already exists — mirroring the one precedence rule verified against real git
2.50.1 (`--global` prefers an *already-existing* XDG file over `~/.gitconfig`,
otherwise falls back to `~/.gitconfig`). See `Config.ts`'s
`resolveGlobalConfigPath` doc comment for the full verification.

Inspection failures are no longer converted into "the XDG file is absent":
the candidate is retained conservatively, so the subsequent `git config`
operation reports the real command/I/O failure instead of choosing the fallback
path on an unreadable filesystem entry.

This can diverge from the file git actually touches if something creates the
XDG file mid-run, or if git's own precedence changes in a future version.
The failure mode if it does diverge is a *weakening* of `FileLock` exclusion
and snapshot coverage for that run, not silent data corruption — worth
tightening later (e.g. by asking git itself once via
`git config --global --list --show-origin`, which can't be done inside
`address` itself since that's a plain synchronous function of props with no
I/O capability per `Reconciler.address`'s signature).

## Known gap: `Config` re-appends on every value change, `ManagedBlock` doesn't

Because `Config.apply` always does `--unset-all` then one `--add` per desired
value (see `Config.ts`'s doc comment for why that's the right shape for
*convergence*), changing the *value* of an existing multi-line-relevant key —
most notably an `includeIf.gitdir:<glob>.path` entry, as used by
`gitIdentity` — moves that entry to the end of the global gitconfig, not just
its content. `Dotfiles.ManagedBlock` (what `gitIdentity` used before this
package existed) rewrites in place instead. `GitPersonaProps.after` still has
to be set correctly across such a change for the same last-match-wins reason
it always did — see `Identity.ts`.

## `packages/shell` integration

`gitIdentity`'s `gh auth switch` directory-change hook delegates to
`@machine-run/shell`'s `hook` composition (`Identity.ts`) rather than
hand-rendering zsh/bash/fish syntax itself, which is what it did earlier in
this same session before `packages/shell` grew backend implementations,
`Store.ts`, and a `package.json`/`tsconfig.json` partway through. `Identity.
ts` still owns `toShellGlob` (converting git's `includeIf gitdir:` glob
syntax into a shell glob) — `@machine-run/shell`'s own `Backend.ts` doc
comment names that exact conversion as this caller's responsibility, not
something `Shell.hook` translates itself.

`gitIdentity` still only accepts `shell: "zsh" | "bash" | "fish"`, not the
full `ShellId` `@machine-run/shell` now supports (`nu`, `pwsh` too) — the
`gh auth switch ... >/dev/null 2>&1` command it hands to `Shell.hook` is
plain POSIX redirection syntax, valid verbatim in those three, not in nu or
PowerShell. Widening `gitIdentity` to every shell `@machine-run/shell`
supports would need a per-family command rendering, which is out of scope
for a straight port of `git-identity`'s existing behaviour.

## `Git.CredentialHelper`'s `libsecret` backend: verified, and distro-variant

Verified in real containers (`docker run --rm ubuntu:24.04` / `fedora:latest`)
rather than assumed:

- **Fedora**: `dnf install git-credential-libsecret` installs a working
  binary straight onto git's own exec-path.
- **Debian/Ubuntu 24.04**: the `git` apt package ships only the *source*
  (`/usr/share/doc/git/contrib/credential/libsecret/git-credential-
  libsecret.c`) plus a `Makefile` — there is no package that installs a
  working binary. `machine-run` does not compile it. On these distros,
  `Git.CredentialHelper({ helpers: ["libsecret"] })` sets `credential.helper`
  correctly, but it resolves to nothing on `PATH` until a human (or a future
  `System.Package`/build-step resource) produces the binary — this fails at
  the next `git push`/credential prompt, never at `apply` time, since the
  resource has no way to check for the binary's existence as part of
  convergence.

**Extended 2026-08-14**: re-verified the Fedora binary and went further —
does `git config` actually accept the value, and does git actually call it?
`docker run --rm fedora:latest`, `dnf install --setopt=install_weak_deps=False
--setopt=tsflags=nodocs git git-credential-libsecret dbus-x11 gnome-keyring`
(git 2.55.0): `git config --global credential.helper libsecret` round-trips
via `git config --global --get-all credential.helper`, and `GIT_TRACE=1 git
credential fill` proves real dispatch — `run_command: 'git credential-libsecret
get'` → `exec: git-credential-libsecret get` → `start_command:
/usr/libexec/git-core/git-credential-libsecret get`.

The actual Secret-Service store/fetch round trip (approve a fake credential,
fill it back, reject it) could **not** be completed, for three distinct,
escalating reasons found by actually trying, not assumed:

1. Plain `docker run` (unprivileged): `could not connect to Secret Service:
   Cannot spawn a message bus without a machine-id: Invalid machine ID in
   /var/lib/dbus/machine-id or /etc/machine-id` — the base image has no
   machine-id.
2. After `dbus-uuidgen > /etc/machine-id`: dbus itself now starts, but
   `gnome-keyring-daemon --unlock --components=secrets --daemonize` fails —
   `error dropping process capabilities - -5, aborting` — blocked by the
   unprivileged container's own capability restrictions.
3. Re-running with `--privileged` clears both of the above — the Secret
   Service genuinely starts — but `git credential approve` now fails
   differently: `store failed: Object does not exist at path
   "/org/freedesktop/secrets/collection/login"`. `gnome-keyring-daemon` only
   materialises the default "login" collection through a fuller session/PAM
   unlock flow than `--unlock` with an empty stdin password provides
   headlessly.

Net effect: the config value and git's resolution/dispatch of it are real and
confirmed; the credential-storage half needs a genuine desktop-session-like
environment this session's containers could not cheaply provide. Distinct
from, and a level deeper than, the Fedora/Debian binary-presence finding
above.

## `Git.CredentialHelper`'s `gh` backend: verified, without authenticating

`docker run --rm ubuntu:24.04`, `gh` installed from its own apt repo
(`cli.github.com/packages`) onto a clean container: git 2.43.0, `gh version
2.97.0`. `git config --global credential.helper "!gh auth git-credential"`
round-trips via `git config --global --get-all credential.helper`.
`GIT_TRACE=1` on `git credential fill` shows git actually dispatching to it —
`run_command: 'gh auth git-credential get'` — which exits `0` with empty
output (this container's own `gh auth status` confirms "You are not logged
into any GitHub hosts"); git then falls through to its own interactive
prompt, which fails on `could not read Username ...: No such device or
address` only because the container has no controlling tty. Nothing here
required signing in to GitHub, per `AGENTS.md` rule 8.

## `Git.CredentialHelper`'s `osxkeychain` backend: verified, without touching the real keychain or config

`git-credential-osxkeychain` is a real, executable 123280-byte binary at
`$(git --exec-path)` on this machine (Apple's Command Line Tools git
2.50.1). Since writing this Mac's real `~/.gitconfig` or reading its real
login keychain is off-limits, dispatch was verified with `git -c
credential.helper=osxkeychain` — a transient, in-process config override
that touches no file on disk — against a host guaranteed absent from the
real keychain (`verify.machine-run-nonexistent.invalid`). `GIT_TRACE=1`
shows git resolving and genuinely executing the real binary:
`run_command: 'git credential-osxkeychain get'` → `exec:
git-credential-osxkeychain get` → `start_command:
/Library/Developer/CommandLineTools/usr/libexec/git-core/
git-credential-osxkeychain get`. The lookup correctly finds nothing (no such
host is enrolled) and git falls through to its own interactive prompt, which
fails only for lack of a controlling tty — the same non-authentication
signal `gh`'s check relies on. `git config --global --get-all
credential.helper` was confirmed to still be unset on this machine
afterwards.

## `Git.Maintenance`: `start`/`stop` are not a matched pair — verified, not assumed

Built against real git 2.43.0 in `docker run --rm ubuntu:24.04` (with, and
then without, `cron` installed) on 2026-08-14, plus read-only checks
(`git maintenance -h`/`git config --get maintenance.strategy`) against the
real host's git 2.50.1. Nothing here was assumed from `man git-maintenance`
without running it — see `AGENTS.md` rule 5.

**`git maintenance start` requires a working scheduler and fails loudly
without one.** With neither `cron`/`crontab` nor a systemd instance
available, `git -C /repo maintenance start` exits `128` with `fatal: neither
systemd timers nor crontab are available` — it does not partially succeed.
Installing `cron` (`apt-get install cron`, then a running `cron` daemon so
`crontab` has somewhere to hand its update off to) made it succeed.

**`start` does two independent things; `register`/`unregister` are the two
halves, separately available.** `git help -a` lists `maintenance` with no
further subcommand detail (no man page in either container), so this was
worked out by running `register`, `unregister`, `start`, and `stop` in
sequence and diffing `~/.gitconfig` and the repo's own `.git/config` after
each:

| Command | Global `~/.gitconfig` | Local `.git/config` | OS scheduler |
|---|---|---|---|
| `register` | adds this repo's canonical toplevel path to multi-valued `maintenance.repo` | sets `maintenance.auto = false`, `maintenance.strategy = incremental` (if unset) | untouched |
| `unregister` | removes this repo's path from `maintenance.repo` | **untouched** — `auto`/`strategy` are never cleared | untouched |
| `start` | same as `register` | same as `register` | installs the shared crontab block (or systemd timer) |
| `stop` | **untouched** — `maintenance.repo` keeps every previously-registered repo | untouched | removes the shared crontab block (or systemd timer) entirely |

The two rows that matter: **`unregister` never clears the local
`auto`/`strategy` keys**, and **`stop` never clears the global
`maintenance.repo` list**. Concretely: register a repo, then unregister it —
`git config --get maintenance.strategy` *inside that repo* still answers
`incremental` forever, even though the repo is no longer registered anywhere.
That rules out `maintenance.strategy` as a live "is this currently active"
signal, which is the check the task brief itself suggested trying first (see
below).

**Re-registering the same repository is idempotent** — running `register`
twice does not duplicate the `maintenance.repo` entry, confirming git
compares against the same canonical toplevel path it stores (not a fresh
string in every call). **`unregister --force` on an already-unregistered
repository exits `0`; without `--force` it exits `128`** with `fatal:
repository '<path>' is not registered` — `--force`, per `git maintenance
unregister -h`, exists exactly to make it idempotent.

**Design consequence: `Git.Maintenance.unapply` calls `unregister --force`,
never `stop`.** `stop` is machine-wide — it would silence background
maintenance for every repository registered on the machine, not just the one
resource being destroyed. `Reconciler.unapply`'s own doctrine (`packages/
engine/src/Reconciler.ts`) is that a half-undo that reports success is worse
than no `unapply` at all; running `stop` from a single resource's `unapply`
would be exactly that class of mistake, just inverted — an *over*-undo that
also reports success. `apply` still calls `start` (not bare `register`),
because `register` alone never gets the background job running at all on a
machine that's never had `git maintenance start` run once — `start` is the
name the task brief and V1-PLAN both name for a reason.

**`observe` checks `maintenance.repo` membership, not `maintenance.strategy`** —
the one signal that toggles correctly both ways, per the table above. This
directly overturned the task brief's own suggested check
("`git config --get maintenance.strategy`"); the honest answer, found by
running it rather than assuming, is that that key is sticky and not a
description of current state at all.

**Not run against real macOS.** Everything above is Linux/cron-verified only.
`git maintenance start` on macOS is documented to use `launchd`, not cron,
and running it for real would install an actual `launchd` job and mutate the
real `~/.gitconfig` on whatever machine runs it — not something to do against
a developer's real, non-disposable machine just to verify a test. That path
(and `systemd --user` timers, as an alternative to cron on Linux) is
UNVERIFIED; `Maintenance.ts`'s only OS-specific assumption is the two exact
strings in `GitMaintenanceSchedulerUnavailable`'s detection regex, which is
Linux-cron-verified only.

## `Git.Signing`: verified end to end, plus a load-bearing finding about what `verify-commit` actually checks

**Updated 2026-08-14 — this section previously said "unverified end-to-end";
that has now been run for real.** `docker run --rm debian:stable`, git
2.47.3: a throwaway `ssh-keygen -t ed25519` key (no passphrase,
container-only), this composition's exact four config keys (`gpg.format
ssh`, `user.signingKey`, `commit.gpgsign true`, `gpg.ssh.allowedSignersFile`),
an `allowed_signers` file in the exact format `gitSigning` generates, `git
commit -S`, then `git verify-commit HEAD` — a real `Good "git" signature for
verify@machine-run.invalid with ED25519 key SHA256:...` and exit `0`. The
composed path genuinely produces a commit that verifies, not just one that
looks signed.

**Three follow-up negative controls, in a second container run, found
something worth knowing before trusting this**: `git verify-commit`'s SSH
check is a key lookup against `allowed_signers`, not an identity check —

| Control | `allowed_signers` contents | Result |
|---|---|---|
| baseline | right key, right principal (`verify@machine-run.invalid`) | `Good signature for verify@machine-run.invalid ...`, exit `0` |
| wrong principal | **right key**, principal set to `someone-else@example.com` (unrelated to the real committer) | `Good signature for someone-else@example.com ...`, exit `0` — **passes** |
| wrong key | a *different* key, under the *right* principal | `Good "git" signature with <fingerprint>` then `No principal matched.`, exit `1` |
| missing file | `allowedSignersFile` points at a path that doesn't exist | `Unable to open allowed keys file ...`, `No principal matched.`, exit `1` |

Read together: the actual public key that produced the signature must appear
*somewhere* in the file, full stop — that part is real and correctly
enforced (rows 3 and 4 fail). But once a key is present, `git verify-commit`
accepts it under *any* principal string attached to it in the file (row 2
passes) — it never cross-checks that string against the commit's real
`author`/`committer` email. `GitAllowedSigner.principals`
(`packages/git/src/Signing.ts`) is therefore legible audit metadata — which
name a human chose to write next to a key — never a cryptographically
enforced identity binding. Anyone whose key is added to a machine's
`allowed_signers` file can have a signature attributed to any principal
already present for a different entry; this is exactly what `ssh-keygen(1)`'s
ALLOWED SIGNERS format and `git verify-commit` implement, not a bug in this
composition, and not fixable from `gitSigning`'s side. Worth knowing before
treating a passing `verify-commit` as proof of *who* signed something, rather
than just proof that *some* trusted key did.
