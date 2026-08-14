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
  `System.Package`/build-step resource) produces the binary.

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

## `Git.Signing`: unverified end-to-end

`packages/git/src/Signing.ts` composes real, individually-verified config
keys (`gpg.format`, `user.signingKey`, `commit.gpgsign`,
`gpg.ssh.allowedSignersFile`) and a real, documented `allowed_signers` file
format, but **nothing in this repository signs anything today** — nobody has
run `git commit -S` against a machine this composition configured and
checked `git log --show-signature`. Said plainly rather than implied
otherwise.
