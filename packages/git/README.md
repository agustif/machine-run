# `@machine-run/git`

Reconciles global `git config` keys, repository clones, and per-repo
background maintenance, plus eight thin compositions over those for the
common cases — identities, ignore/attributes files, aliases, credential
helpers, signing, and a shared hooks directory.

## What it exports

| Resource          | Reconciles                                                  |
| ----------------- | ----------------------------------------------------------- |
| `Git.Config`      | one global `git config` key, ordered values                 |
| `Git.Repo`        | a clone and its `origin` remote                             |
| `Git.Maintenance` | `git maintenance` background upkeep registered for one repo |

`Git.Config` is the load-bearing resource: every composition below writes one
or more config keys through it, never a second way to write the same key.

| Composition           | What it does                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `gitIdentity`         | one persona's `user.name`/`user.email`, scoped to a path glob via `includeIf.gitdir`           |
| `gitIgnore`           | a machine-wide `.gitignore`, wired in via `core.excludesFile`                                  |
| `gitAttributes`       | a machine-wide `.gitattributes`, wired in via `core.attributesFile`                            |
| `gitAlias`            | one `alias.<name>` config value                                                                |
| `gitSigning`          | SSH-based commit/tag signing (`gpg.format=ssh`) plus the `allowed_signers` file                |
| `gitCredentialHelper` | `credential.helper`, from the `osxkeychain`/`libsecret`/`gh` backend seam                      |
| `gitHooksPath`        | a shared hooks directory wired in via `core.hooksPath`, plus one file per hook                 |
| `gitConfigFile`       | the shared shape behind `gitIgnore`/`gitAttributes`: a config key pointing at a generated file |

None of the compositions are `Reconciler`s themselves — each is a plain
function composing `Git.Config` and/or `@machine-run/dotfiles` resources,
which is why they carry no state of their own. See
[../../docs/MAP.md](../../docs/MAP.md) §3.

## Example

From
[`examples/complete-machine/recipes/git.ts`](../../examples/complete-machine/recipes/git.ts):

```ts
import * as Git from "@machine-run/git";

// An identity scoped to a path glob. `~/.gitconfig` resolves `includeIf`
// last-match-wins, so a narrower persona must be written after a broader one.
yield *
  Git.gitIdentity({
    persona: "personal",
    name: "Your Name",
    email: "you@example.com",
    pathGlob: "~/**",
    personaConfigPath: "~/.gitconfig-personal",
    gitconfigPath: "~/.gitconfig",
  });

// A clone. `branch` applies only to a fresh clone — apply never runs
// `checkout`, so an existing repository's current branch is left alone.
yield *
  Git.Repo("dotfiles-repo", {
    path: "~/code/dotfiles",
    remote: "https://github.com/example/dotfiles.git",
    branch: "main",
  });

// Background maintenance for one repository.
yield *
  Git.Maintenance("dotfiles-maintenance", {
    repo: "~/code/dotfiles",
  });
```

The full recipe also exercises ignore/attributes/aliases/credentials/signing/hooks.

## Verification status

`Git.Config` and `Git.Repo` are tested against real git (`test/Config.test.ts`,
`test/Repo.test.ts`), including `Git.Repo`'s `remote set-url` verified against
real git 2.50.1 to leave a modified working tree byte-for-byte unchanged.
`Git.Maintenance` was container-verified against real git 2.43.0
(`docs/notes/git-notes.md`) for the crontab scheduling path; the macOS
`launchd` scheduler path and Linux systemd-timer scheduling were **not**
run — doing so would mutate a real machine's schedule or install a real
background job. `Git.Repo` currently fails three of its `apply` tests on the
Windows CI runner for an undiagnosed reason — see
[TASKS.md](./TASKS.md) and [../../docs/MAP.md](../../docs/MAP.md) §7.

The `CredentialHelperBackend` seam (`osxkeychain`, `libsecret`, `gh`) is
**entirely unverified** — see [../../docs/MAP.md](../../docs/MAP.md) §4:
`osxkeychain` needs a real login keychain, `libsecret` a session keyring, and
even `gh auth git-credential`, the easiest of the three to check in CI, has
not been run. `Git.Signing` is unexercised end-to-end: nothing in this repo
has ever run `git commit -S` and confirmed the result verifies — the one
composition where being subtly wrong produces a commit that merely _looks_
signed.

## What it deliberately does not do

- **`Git.Maintenance.unapply` never calls `git maintenance stop`.** `stop` is
  machine-wide — it tears down the scheduler for every registered repository,
  not just this one — so `unapply` runs `git maintenance unregister --force`
  instead, which is scoped correctly to this resource's own repository. This
  is a real, verified finding, not the obvious first guess.
- **`Git.Repo` never runs `checkout`, `reset`, `clean`, `pull`, or `fetch`.**
  Only `git clone` (nothing there yet) and `git remote set-url` (wrong
  remote) exist. Every other operation an "ensure this repo is up to date"
  tool reaches for can discard uncommitted or unpushed work, so none of them
  are here, and there is no `unapply`.
- **No per-repo config.** Everything here writes global config or a
  persona's `includeIf` fragment. A machine's per-repo settings need
  `Git.Config` to take an optional repo path, which it doesn't yet.
- **`Git.Repo` reconciles only `origin`.** A fork workflow needing `upstream`
  too is unsupported.

See [TASKS.md](./TASKS.md) for the rest, including the concurrency question
around `git config --global`'s own file lock.
