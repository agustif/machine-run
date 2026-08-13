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

## `Git.Signing`: unverified end-to-end

`packages/git/src/Signing.ts` composes real, individually-verified config
keys (`gpg.format`, `user.signingKey`, `commit.gpgsign`,
`gpg.ssh.allowedSignersFile`) and a real, documented `allowed_signers` file
format, but **nothing in this repository signs anything today** — nobody has
run `git commit -S` against a machine this composition configured and
checked `git log --show-signature`. Said plainly rather than implied
otherwise.
