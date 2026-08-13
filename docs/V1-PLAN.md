# machine-run → v1

The honest state of this repo, a first-principles map of what a personal-machine
reconciler actually has to cover, and the ordered plan to get there.

This document deliberately does **not** describe the machine it was developed on.
The previous iteration of this codebase was scoped to whatever happened to be
installed on a nearly-empty new laptop — nine packages covering dotfiles,
packages, one network daemon and one OS-settings mechanism — and then documented
that scope as though it were a design. The map below starts from "what is a
configured machine" and works down, so the gaps are visible as gaps.

---

## 1. Where things actually stood

Findings from an adversarial pass over every source file, verified by running
`tsc`, `vitest`, `npm install`, and by reading Alchemy's and Effect's shipped
types rather than trusting the previous session's notes.

### The repo did not compile. At all.

`npm run check` failed before reaching a single line of machine-run's own logic:

| # | Finding | Reality |
|---|---|---|
| 1 | `tsconfig.base.json` set `"types": ["bun"]` with no `@types/bun` installed | Every project failed with `TS2688` immediately |
| 2 | `Backend.ts` used `Context.Tag.Service<typeof CommandExecutor>` | **`Context.Tag` does not exist in Effect 4.** It resolved to `unknown`, erasing the type of every backend's `result` and cascading 43 errors through `system-packages`. The previous handoff recorded this as *fixed* |
| 3 | `detect.ts` declared its error channel `never` | `fs.exists` yields `PlatformError`; the signature was a lie the compiler rejected |
| 4 | Stale `lib/` output with `.js` but no `.d.ts` | Poisoned cross-package resolution with misleading "could not find a declaration file" errors |

The correct Effect 4 form is `typeof CommandExecutor.Service`. That one line
fixed all 43 downstream errors.

### The prior "verification" claims were not true

The handoff asserted tests were *"blocked by an alchemy-test/alchemy version-skew
bug, not our code."* That is false in both halves. `Provider.effect(File, body)`
is literally `Layer.effect(Provider("Machine.File"), body)` — the body is an
ordinary `Effect` returning an ordinary object with `read`/`diff`/`reconcile` on
it. Nothing ever prevented calling those directly against a temp directory. The
harness was never the blocker.

### Correctness bugs found by reading

Ordered by how badly they'd hurt on a machine that already has a config — which
is every machine except the one this was written on.

1. **Concurrent writers to one file silently lose blocks.** Alchemy's `Apply.ts`
   applies resources with `concurrency: "unbounded"`. `ManagedBlock`'s reconcile
   is a read-modify-write. Two blocks in one file are independent resources, so
   they race and the loser's stanza vanishes. `gitIdentity()` puts one block per
   persona in `~/.gitconfig` *and* one per persona in `~/.zshrc`; `sshHost()`
   puts one per host in `~/.ssh/config`. A two-persona, three-host recipe races
   five ways, reports success, and leaves a plausible-looking file missing a
   stanza.
2. **`diff` never observed live state.** `File` and `ManagedBlock` compared
   desired content against `output.hash` — the hash of what machine-run last
   *wrote*. That answers "did the recipe change", not "does the machine match the
   recipe". A hand-edited file stayed broken forever. `MacOS.Default`,
   `System.Package` and `Tailscale.Connection` had the same blindness. Only
   `Symlink` observed reality.
3. **`diff` ignored most props.** Keyed on content hash alone, so changing
   `path`, `marker`, `mode`, or `opRef` was a no-op: repointing a `SecretFile` at
   a different vault item left the old secret on disk, and tightening a file from
   `0644` to `0600` changed nothing.
4. **apt PPAs were never added.** `Repo.ts` guards on `if (listRepos && addRepo)`.
   `Apt.ts` defines `addRepo` but not `listRepos`, so the branch never ran — and
   reconcile still returned success.
5. **`OnePassword.read` called `.trim()` on every secret.** OpenSSH rejects a
   private key without its trailing newline. Every SSH key this ever materialised
   was invalid.
6. **`SecretFile` wrote then chmod'd**, leaving the secret world-readable at the
   process umask between the two syscalls.
7. **Dangling symlinks crashed reconcile.** `fs.exists` follows links, so a link
   whose target was deleted read as "absent", the clear-the-path branch was
   skipped, and `fs.symlink` failed `EEXIST`.
8. **Symlink compared raw path strings.** `~/vault`, `/Users/a/vault` and
   `/Users/a/vault/` compared unequal forever — a permanent non-converging diff.
9. **`toShellGlob` over-matched.** `/Users/a/work/**` became `/Users/a/work*`,
   which also matches `/Users/a/workshop`, silently applying the wrong git
   identity.
10. **`toId` collided.** `foo/bar` and `foo-bar` both sanitise to `foo-bar`, so
    two different packages shared one Alchemy logical ID and one silently
    overwrote the other's state.
11. **Shell injection / broken quoting throughout.** `MacOS.Default` interpolated
    `domain`/`key`/`value` into a `shell: true` string, so any string value
    containing a space was silently split into extra arguments. `OnePassword`
    escaped only `"`, leaving `$()` and backticks live.
12. **`~/.ssh` created at the process umask.** ssh refuses a directory that isn't
    `0700`.
13. **`detect.ts` returned `"brew"` for Windows.**
14. **Unchecked `JSON.parse(x) as T`** in the npm and tailscale backends — a cast
    that told the compiler the shape was verified when nothing had checked it.
15. **`Doppler` was unreachable code.** Implemented, exported, wired into
    nothing — because its shape (`run` a command with env injected) is not a
    secret-store *read* and could never back `SecretFile`.
16. **`renderFile` corrupted files with mismatched markers.** `indexOf(begin)`
    and `indexOf(end)` were computed independently, so an inverted or unpaired
    pair spliced into nested, duplicated garbage that got worse every run.

### Tests that tested nothing

`File.test.ts` and `Symlink.test.ts` asserted that `fs.writeFileString` writes a
file and that `fs.symlink` creates a symlink. They imported none of the code they
claimed to cover. They have been deleted, not fixed — false coverage is worse
than none, because it makes the gap invisible.

---

## 2. First-principles map

What is actually on a configured machine, independent of what this repo happens
to support. `✓` shipped, `~` partial, `✗` missing.

```
machine
├── identity & auth
│   ├── git identities (name/email/signing, per-path)            ✓
│   ├── ssh config + hosts                                       ✓
│   ├── ssh keys (materialised from a vault)                     ✓
│   ├── ssh known_hosts / agent config                           ✗
│   ├── GPG keys + trust + git signing                           ✗
│   ├── forge CLI auth (gh, glab)                                ~  zsh-only hook
│   ├── cloud profiles (aws, gcloud, az)                         ✗
│   └── kubeconfig contexts                                      ✗
│
├── software
│   ├── OS package managers                                      ✓  brew, cask, port,
│   │                                                                apt, dnf, pacman
│   ├── Windows package managers                                 ~  winget, choco (new)
│   ├── language-global packages                                 ~  npm, cargo only
│   │   └── missing: pipx, uv tool, gem, go install, composer
│   ├── language runtimes / version managers                     ✗  mise, asdf, rustup,
│   │                                                                nvm, pyenv, uv
│   ├── extra repositories (taps, PPAs, COPR)                    ~  brew ✓, apt (fixed),
│   │                                                                dnf/pacman ✗
│   ├── Mac App Store (mas)                                      ✗
│   ├── Nix / home-manager                                       ✗
│   ├── flatpak / snap / AUR                                     ✗
│   └── containers (docker, orbstack, colima)                    ✗
│
├── shell & terminal
│   ├── login shell (chsh, /etc/shells validation)               ✗
│   ├── profile blocks (rc files)                                ~  raw ManagedBlock,
│   │                                                                no shell awareness
│   ├── PATH entries                                             ✗
│   ├── env vars / aliases / functions                           ✗
│   ├── directory-change hooks                                   ~  zsh-only, hardcoded
│   ├── prompt (starship, p10k)                                  ✗
│   ├── completions                                              ✗
│   ├── terminal emulator (ghostty, wezterm, kitty, iterm)       ✗
│   └── multiplexer (tmux, zellij)                               ✗
│
├── editors & dev tooling
│   ├── VS Code / Cursor settings + extension sets               ✗
│   ├── JetBrains / neovim                                       ✗
│   ├── global gitignore / gitattributes / git hooks             ✗
│   ├── direnv, EditorConfig                                     ✗
│   └── AI coding CLI configs + skills                           ✓
│       └── MCP server registration                              ✗
│
├── OS settings
│   ├── macOS `defaults` (scalar: bool/int/float/string)         ✓
│   ├── macOS `defaults` (array/dict/data)                       ✗  see §4
│   ├── macOS: hostname, dock items, login items, keyboard
│   │   remap (hidutil), pmset, firewall, screenshot location    ✗
│   ├── Linux: gsettings/dconf, sysctl, udev                     ✗
│   └── Windows: registry                                        ✗
│
├── services & scheduling
│   ├── launchd agents (macOS)                                   ✗
│   ├── systemd user units (Linux)                               ✗
│   ├── brew services                                            ✗
│   └── cron                                                     ✗
│
├── network
│   ├── Tailscale                                                ✓
│   ├── /etc/hosts                                               ✗
│   ├── DNS / resolver                                           ✗
│   └── VPN / proxy / wifi                                       ✗
│
├── filesystem
│   ├── owned files                                              ✓  Machine.File
│   ├── blocks in shared files                                   ✓  Machine.ManagedBlock
│   ├── symlinks                                                 ✓  Machine.Symlink
│   ├── directories (mode, ownership)                            ✗  no primitive at all
│   ├── templated files                                          ✗
│   ├── single lines in a file                                   ✗
│   ├── downloads (URL → path, checksum-verified)                ✗
│   └── archive extraction                                       ✗
│
├── assets
│   ├── fonts                                                    ✗
│   └── wallpapers / icons                                       ✗
│
└── operations
    ├── plan / deploy                                            ✓  via alchemy
    ├── drift report / doctor                                    ✗
    ├── inventory & import (`list`/`read` hooks)                 ~  `read` added to
    │                                                                dotfiles only
    ├── bootstrap                                                ✓  bootstrap.sh
    └── CI                                                       ✗
```

### The structural read

Three things fall out of that map, and they matter more than any individual
missing feature.

**A. The primitive layer is incomplete in a way that blocks everything above it.**
There is no `Machine.Directory`. Nothing in this framework can say "ensure
`~/.config/foo` exists with mode 0700" without also writing a file into it. Fonts,
downloads, archives and templates are all likewise absent. Every domain package
above has to re-improvise these.

**B. The backend seam is the good idea, and it is applied to exactly one thing.**
`PackageManagerBackend` — one interface, one small module per implementation, one
generic resource dispatching by id — is the right shape. Secrets have now been
migrated onto the same shape. But *shells*, *service managers*, and *OS settings
stores* are all the identical problem and have no seam at all: the shell hook is
hardcoded zsh, and `MacOS.Default` is a macOS-specific resource where it should
be one `System.Setting` resource with `defaults` / `gsettings` / `registry`
backends behind it.

**C. Observation is treated as optional.** Every `list` was `() => Effect.succeed([])`
and no resource implemented `read`. That forfeits adoption (the engine can't
discover a machine that's already correct) and made drift undetectable. A
reconciler that only knows what it wrote is a deployment script with extra steps.

---

## 3. Target package hierarchy

> **Historical.** This is the target map as it stood when v1 was *planned*, and
> its `✓`/`✗` marks describe that moment — several things marked `✗` here
> (`shell`, `runtimes`, `Directory`, `Download`, `Exec`, `System.Setting`, the
> language and Linux package backends) have since been built. It is kept because
> the reasoning under it is what chose the breadth.
>
> For what exists **now**, with verified-versus-merely-written marked per piece,
> see [MAP.md](./MAP.md).

```
                        ┌─────────────────────────────┐
                        │  alchemy  (Resource/Provider │   engine seam
                        │  /Layer/state/Command)       │
                        └──────────────┬───────────────┘
                                       │
┌──────────────────────────────────────┴───────────────────────────────────┐
│  @machine-run/core            — machine substrate, no resources          │
│    MachinePaths   ~ expansion, normalisation      ✓ new                  │
│    Backups        one snapshot dir per run        ✓ new                  │
│    FileLock       per-path write serialisation    ✓ new                  │
│    Sh             POSIX + PowerShell quoting      ✓ new                  │
│    sha256                                         ✓                      │
│    Platform       os/arch/distro facts            ✗ planned              │
└──────────────────────────────────────┬───────────────────────────────────┘
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        │                              │                              │
┌───────┴────────┐          ┌──────────┴──────────┐        ┌──────────┴─────────┐
│ PRIMITIVES     │          │ BACKEND SEAMS       │        │ SYSTEM RESOURCES   │
│ (dotfiles)     │          │ (one iface + N impl)│        │                    │
│                │          │                     │        │                    │
│ File        ✓  │          │ PackageManager   ✓  │        │ Tailscale.Conn  ✓  │
│ ManagedBlock✓  │          │   brew cask port    │        │ System.Service  ✗  │
│ Symlink     ✓  │          │   apt dnf pacman    │        │   launchd/systemd  │
│ Directory   ✗  │          │   cargo npm         │        │ System.Setting  ✗  │
│ Template    ✗  │          │   winget choco ~    │        │   defaults/dconf/  │
│ LineInFile  ✗  │          │   pipx uv gem go ✗  │        │   registry         │
│ Download    ✗  │          │   mas nix flatpak✗  │        │ System.Host     ✗  │
│ Archive     ✗  │          │                     │        │ Machine.Exec    ✗  │
│ Exec        ✗  │          │ SecretBackend    ✓  │        │                    │
│                │          │   1password doppler │        └────────────────────┘
└───────┬────────┘          │   keychain pass env │
        │                   │   bitwarden      ✗  │
        │                   │                     │
        │                   │ ShellBackend     ✗  │
        │                   │   zsh bash fish nu  │
        │                   │                     │
        │                   │ RuntimeBackend   ✗  │
        │                   │   mise asdf rustup  │
        │                   └──────────┬──────────┘
        │                              │
┌───────┴──────────────────────────────┴───────────────────────────────────┐
│  DOMAIN PACKAGES — compose primitives + seams, define no new engine shape │
│                                                                           │
│   git-identity ✓   ssh ✓   ai-tools ✓   secrets ✓   system-packages ✓     │
│   shell ✗   editors ✗   fonts ✗   runtimes ✗   containers ✗   net ✗       │
└──────────────────────────────────┬────────────────────────────────────────┘
                                   │
┌──────────────────────────────────┴────────────────────────────────────────┐
│  COMPOSITION — lives in the user's own private machines-<you> repo        │
│  personas, roles, per-machine recipes. machine-run ships none of this.    │
└───────────────────────────────────────────────────────────────────────────┘
```

The rule that keeps this from sprawling: **a new domain package may not introduce
a new engine concept.** It composes primitives and dispatches through a seam. If
something genuinely needs a new resource type, it belongs in the SYSTEM
RESOURCES column and needs an explicit justification, because every resource type
is a permanent state-schema commitment.

### Package granularity: scope to a domain, not to one function

> **Shipped.** Both renames below happened. `@machine-run/git` and
> `@machine-run/ai` own their domains, with `Git.Config`, `Git.Repo`,
> `Ai.McpServer` and the backend seam all built; the `git-identity` and
> `ai-tools` shims that briefly re-exported them have been deleted. The tables
> below are kept as the reasoning, not as a plan. Only `Git.Maintenance` from
> that list was never built.

Two packages were mis-scoped, and it showed. They had been named after the one
thing that was needed on the day, not after the surface they belong to.

**`git-identity` → `@machine-run/git`.** Identity is one slice of git
configuration. A machine's git surface is much larger, and all of it is
config-shaped and reconcilable:

| | |
|---|---|
| `Git.Config` | one global key/value, atomic, diffed live via `git config --global --get <key>` — the same shape as `MacOS.Default` |
| `gitIdentity()` | personas + `includeIf` (exists today) |
| `Git.Ignore` / `Git.Attributes` | global `core.excludesfile` / `core.attributesfile` |
| `Git.Signing` | `gpg.format=ssh`, `user.signingkey`, `allowed_signers` — currently nothing signs anything |
| `Git.CredentialHelper` | osxkeychain / libsecret / `gh auth git-credential` |
| `Git.Alias` | one alias per resource |
| `Git.HooksPath` | `core.hooksPath` + a managed hooks directory |
| `Git.Repo` | ensure a clone exists at a path (dotfiles repo, work checkouts) |
| `Git.Maintenance` | `git maintenance start` |

`Git.Config` is the load-bearing one: with a live `git config --get` diff it
subsumes most of the list above, and it's a ~40-line resource.

**`ai-tools` → `@machine-run/ai`, with a real seam.** It was two frozen
arrays of paths and a loop. Every entry hardcodes an assumption about a tool's
layout, and nothing dispatches. It should follow the same backend shape as
packages and secrets:

```
AiToolBackend { id, skillsDir, configFiles, mcpConfigPath, mcpConfigFormat }
  backends/  claude.ts  codex.ts  cursor.ts  gemini.ts  copilot.ts  opencode.ts …
```

with `Ai.Skill` (one skill dir), `Ai.Config` (one config file), and — the real
gap — **`Ai.McpServer`**, registering an MCP server into a tool's config. Every
tool stores MCP servers in a different JSON shape, which is precisely the kind of
per-implementation difference a backend seam exists to absorb. The
reviewed-allowlist posture stays: never a blanket directory symlink.

**`ssh` is borderline** — `sshHost()` exists, but `Ssh.KnownHost`, `Ssh.Key`
(generate or materialise) and agent configuration all belong with it. Still true:
none of those three were built, and `ssh` remains composition-only, which is also
why `@machine-run/machine` does not aggregate it.

The general rule going forward: **a package owns a domain and grows backends
inside it.** If a package would only ever contain one function, it's a function
in an existing package, not a package.

### Atomic resources and manifest resources are complementary

The "no bundle resources" rule was over-applied. It exists to stop someone
*inventing* a resource that owns N unrelated objects — the original
Homebrew-bundle god-resource deserved to go. But it was then read as "delete
Brewfile support", which threw away a real capability to satisfy a slogan.

A `Brewfile` is not an invented aggregate. It is a real, first-class Homebrew
artifact with a single identity, its own idempotent apply (`brew bundle`), and
its own check command (`brew bundle check`). Modelling it is modelling one
external object, which is exactly what a resource is for.

So there are two legitimate layers, and machine-run should support both:

| Layer | Unit of identity | Good for |
|---|---|---|
| **Atomic** — `System.Package` | one installed package | fine-grained drift detection, mixing managers, per-package conditionals |
| **Manifest** — `Brew.Bundle`, `Mise.Toml`, `Asdf.ToolVersions`, `Nix.Flake`, `Code.Extensions` | one real ecosystem file | matching how the ecosystem actually works, `cleanup` semantics, sharing the file with non-machine-run tooling |

The rule that keeps them honest: a manifest resource must model a file the
*ecosystem itself* defines, must have a real idempotent apply, and must not
silently fight the atomic layer. A recipe managing both a `Brewfile` and atomic
`System.Package`s for brew is a conflict, and machine-run should detect and
refuse it rather than let two writers race.

---

## 3b. Alchemy primitives not yet bridged

Alchemy ships more than `Resource`/`Provider`, and several of its primitives
answer gaps recorded elsewhere in this document as unsolved. Adopting them is
cheaper than building equivalents, and closer to the engine's intent.

### `Action` — graph nodes without a provider lifecycle

An `Action` has a logical id and typed input, runs an Effect when its input
changes, and has no `read`/`delete`/`replace`. Removing one drops its state
without running anything.

That is exactly the shape of the side effects currently smuggled into
`reconcile` bodies. `MacOS.Default` runs `killall Dock` inside its own apply,
so a recipe setting eight Dock keys restarts the Dock up to eight times; an
`Action` whose input is the set of applied dock values restarts it **once,
after** they land. It is also the honest home for the `Machine.Exec` escape
hatch (P1) and for Doppler's `run`-with-injected-env shape, neither of which
is really a *resource* — nothing is owned, nothing is destroyed.

### `RemovalPolicy` — the missing unmanage story

`delete` is a no-op in every resource here, which leaves no way to back out.
Alchemy already models the choice: `RemovalPolicy` is `"retain" | "destroy"`,
scoped with `retain(...)`.

So the invariant should be *`retain` is the default*, not *delete does
nothing*. Under `destroy`, `Machine.ManagedBlock` removes its region,
`Machine.Symlink` restores what it displaced from the backup, `MacOS.Default`
reverts. That converts a documented dead end into a supported operation
without inventing a mechanism.

### `KeyPair` — real key management

Alchemy has a `KeyPair` resource generating `ed25519` / `rsa` / `ec` pairs.
`Machine.SecretFile` only *materialises* a key that already exists in a vault;
combined with `KeyPair`, a recipe can generate one, publish the public half as
a `Machine.File`, and keep the private half out of state — without this
project writing any crypto.

### `ProviderMode` — a way to try a recipe safely

Providers can register `live` and `local` variants, and the engine plans a
mode switch as a replacement. A `local` mode that writes into a sandbox
directory instead of `$HOME` would let someone exercise a whole recipe without
touching their machine — the most useful possible answer to "this has never
been deployed anywhere."

### `Artifacts` — stop observing twice per apply

`Artifacts` is a per-resource, per-run bag explicitly intended for "`diff`
computes something expensive, `reconcile` reuses it".

`toProvider` currently calls `observe` in `diff` and again inside `reconcile`.
For a filesystem resource that is a cheap `stat`; for `System.Package` or
`Tailscale.Connection` it is a second shell-out per resource per apply. The
observation from `diff` should be stashed and reused, with the re-observe kept
only when the bag is empty — the bag is ephemeral by design and must never be
required for correctness.

### `Namespace.push` — scoped logical ids

Composition functions currently hand-build unique ids by prefixing
(`gitconfig-${persona}`), and `bulk.ts` has a `toId` that had to be fixed for
collisions. `Namespace.push("personal", ...)` scopes the ids of everything
constructed inside it, which removes that whole class of bug rather than
guarding it.

---

## 4. Ordered plan

### Phase 0 — the floor (done in this pass)

- [x] Repo compiles. `types: ["bun"]` → `["node"]`; `Context.Tag` → `typeof X.Service`.
- [x] Stricter tsconfig: `noUnusedLocals`, `noUnusedParameters`,
      `noUncheckedIndexedAccess`, `noImplicitOverride`,
      `noFallthroughCasesInSwitch`. Each of these caught a real latent bug —
      `noUncheckedIndexedAccess` alone exposed two `list()` implementations
      returning `(string | undefined)[]` behind a `string[]` signature.
- [x] Explicit TS project references instead of relying on root-tsconfig ordering.
- [x] Deleted the three tautological tests.

### Phase 1 — correctness (done in this pass)

- [x] `FileLock` — per-path serialisation of read-modify-write reconciles.
- [x] Live-state `diff` for `File`, `ManagedBlock`, `MacOS.Default`.
- [x] `diff` honours all props (path, marker, mode, ref, source).
- [x] `read` implemented for the dotfiles resources → real adoption.
- [x] `Backups` service: one run-scoped directory under
      `~/.local/state/machine-run/backups/<stamp>/`, mirroring full source paths.
      Replaces scattered `.machine-run-backups` dirs — including one written
      *inside* `~/.ssh`.
- [x] `Sh` quoting; every value-bearing command quoted.
- [x] `Schema` decode replacing unchecked `JSON.parse(...) as T`.
- [x] `SecretBackend` seam; `SecretFile` gains `source`, `trailingNewline`,
      `directoryMode`, and creates with mode `0600` rather than chmod-after-write.
- [x] Symlink: dangling-link handling, path normalisation, typed
      `SymlinkPathUnreadable` instead of `Effect.option` swallowing everything.
- [x] `ManagedBlockMalformed` instead of corrupting mismatched markers.
- [x] `commentPrefix` / `position` / `after` on `ManagedBlock`.

### Phase 2 — the missing primitives (next)

These are prerequisites for most of Phase 3, and each is small.

1. `Machine.Directory` — path, mode, optional owner. The single most-missed
   primitive.
2. `Machine.Exec` — an escape hatch with real idempotency guards (`unless`,
   `creates`), because without guards it's just a shell script again.
3. `Machine.Download` — URL → path with a required checksum. Gates fonts and
   binary installs.
4. `Machine.Archive` — extract into a directory.
5. `Machine.Template` — render from data; `File` only takes raw content today.

### Phase 3 — the missing seams

6. **`ShellBackend`** (`zsh` | `bash` | `fish` | `nu` | `pwsh`) with `rcPath`,
   `commentPrefix`, and renderers for env / PATH / alias / chdir-hook. Then
   `@machine-run/shell` exposing `Shell.Profile`, `Shell.PathEntry`,
   `Shell.EnvVar`, `Shell.Alias`, `Shell.Hook`, and `Shell.Login` (`chsh`, with
   `/etc/shells` validation). This retired the hardcoded zsh hook that
   `git-identity` carried.
7. **`System.Setting`** with `SettingsBackend` — generalises `MacOS.Default` to
   `defaults` / `gsettings` / `dconf` / Windows registry. `MacOS.Default` becomes
   a thin alias.
8. **`System.Service`** with `ServiceBackend` — `launchd` / `systemd --user` /
   `brew services`.
9. **`RuntimeBackend`** — `mise` / `asdf` / `rustup` / `uv`. Probably the highest
   day-one value still missing for a dev machine.
10. More `PackageManagerBackend`s: `pipx`, `uv tool`, `gem`, `go install`, `mas`,
    `flatpak`, `snap`, AUR helpers, `nix`.
11. More `SecretBackend`s: `bitwarden`, AWS Secrets Manager, HashiCorp Vault.

### Phase 4 — Windows as a real target

The quoting seam is in place (`Sh.pwsh`, `Sh.quotePwsh`), which was the actual
blocker — `shell: true` is `cmd.exe` on Windows, where POSIX single-quoting is
not merely suboptimal but wrong, passing literal quote characters through as part
of the argument. Remaining: a `Platform` service, `winget`/`choco`/`scoop`
backends hardened, registry settings backend, a PowerShell `bootstrap.ps1`, and
path handling that doesn't assume `/`.

### Phase 5 — operations

12. **Doctor / drift report.** Now meaningful, because `diff` observes live state.
13. **Import / adopt.** Implement `list` and `read` on `System.Package` so an
    existing machine can be inventoried into a recipe rather than hand-written.
14. **CI** — the `fakeExecutor` pattern already proves backends can be tested
    without touching a real system.
15. **Publish** — license, versioning, and validating the `exports` maps for a
    non-workspace consumer.

---

## 5. Open questions

Answered questions move into the design log; what stays here needs a decision
rather than more code.

### Answered since this was written

- **macOS array/dict/data defaults** — `MacOS.Default` carries any
  property-list value via `defaults export | plutil -extract xml1`. `plutil`
  validates a whole document against the target format before emitting, so
  JSON is unusable for any domain containing `<data>`; XML is not.
- **apt repository detection** — Ubuntu 24.04 ships *only* deb822 `.sources`,
  verified in a container. Both formats are parsed against captured fixtures.
- **Which layer owns `Crypto`** — `core`'s `services()`, since Alchemy's
  `StackServices` carries `FileSystem`/`Path`/`HttpClient`/`ChildProcessSpawner`
  but not `Crypto`.
- **How dependency versions stay consistent** — packages declare peer *ranges*;
  the root `package.json` pins the exact version for the whole effect family
  plus `alchemy` in `overrides`. Exact peer pins in every package meant one
  bump touched every package's file and any skew was an `ERESOLVE` wall; a missing
  `alchemy` override let a second copy install, which is a dual-package hazard
  given its identity-sensitive `Resource`/`Provider` machinery.
- **Windows verification** — GitHub Actions supplies `windows-latest` and
  `macos-latest` runners, which removed the "unreachable target" excuse
  entirely. CI captures real `winget`/`choco`/`defaults` output and asserts the
  parsers against it in the same job; the captured output is committed as
  fixtures. It immediately found a real bug in the winget parser (see
  [MAP.md](./MAP.md#4-the-six-backend-seams)). Windows runs `tsc -b` only —
  16 tests genuinely fail there, enumerated in [TASKS.md](./TASKS.md).

### Genuinely open

- **Alchemy's CLI cannot complete a `plan`.** See
  [V2-PLAN.md](./V2-PLAN.md#the-blocker) — this now gates everything and is not
  a machine-run bug, but the answer to "do we wait, work around, or vendor"
  is a decision nobody has made.

- **Secret rotation is undetectable by construction.** `SecretFile` diffs on
  existence, permissions and `ref`, never content, because hashing a secret
  puts secret-derived data in unencrypted state. Rotating a value behind an
  unchanged `ref` is therefore invisible. Both obvious alternatives are worse:
  store a hash (forbidden), or fetch every secret on every `plan`, turning a
  read-only preview into something that hits the vault and can prompt for
  biometrics. Unexplored third option: ask the *store* when the item last
  changed — 1Password exposes item version metadata — which detects rotation
  without ever reading the value.

- **Ordering in shared files is opt-in, and forgetting is silent.** `after`
  makes ordering deterministic by manufacturing a dependency edge, but nothing
  requires it, so two `includeIf` regions with no `after` get an arbitrary
  winner and no warning. Refusing a second unordered region in one file is
  safer and worse to use; inferring from declaration order reads naturally but
  silently disagrees with how the engine schedules. Still needs a call.

- **`-array-add` / `-dict-add` are additive**, so they converge toward a
  superset rather than toward equality — `matches` becomes "contains". That is
  a different reconciler contract and needs an explicit `mode` prop rather than
  a silent merge.

- **Which resources may honestly claim to reverse themselves.**
  `RemovalPolicy` supplies the mechanism and two resources implement `unapply`;
  the remaining ~18 do not. Reverting a `defaults` key has no defined "before"
  if the original was never recorded, and restoring a backup is only right if
  the backup is still the right answer. The mechanism should not outrun the
  policy any further than it already has.

- **Resource type naming.** `Machine.*`, `System.*`, `MacOS.*`, `Tailscale.*`,
  `Git.*`, `Ai.*`, `Runtime.*`, `Shell.*` — eight conventions, and the
  `Machine`/`System` split stopped meaning anything once both became
  reconcilers. Renaming is a state-schema break, so this has to be settled
  before anything ships rather than after.
