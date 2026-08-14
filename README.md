# machine-run

A personal-machine reconciler built on [Alchemy](https://alchemy.run) and
[Effect](https://effect.website). It treats your laptop or server the way
Alchemy treats a cloud account: a dotfile, an installed package, a macOS
default, a Tailscale connection, a materialized secret are each a typed,
reconciled **resource**, not a line in a shell script.

> **Status: pre-1.0.** `plan`, `deploy`, drift detection and `destroy` all
> work end to end — `scripts/deploy-check.sh` runs the full sequence against a
> container and passes. 646 tests pass across 65 files, and resource parsers
> are additionally checked against real systems (Linux containers, a macOS
> runner, a Windows runner — which is how a real bug in the winget parser was
> found). What hasn't happened yet: a deploy against a live personal machine.
>
> [docs/MAP.md](./docs/MAP.md) marks every piece `✓` verified / `~` unverified /
> `✗` not built, and [docs/V2-PLAN.md](./docs/V2-PLAN.md) has current priorities.

## Why not a shell script

Setup scripts are order-dependent and non-idempotent. They can't tell you what
would change before changing it, they clobber hand-written config they don't
understand, and "did this already run?" is answered by running it again and
hoping.

A reconciler answers a different question — *does the machine match the recipe
right now* — and converges only what doesn't:

```sh
node_modules/.bin/alchemy plan   <recipe.ts>          # preview; changes nothing
node_modules/.bin/alchemy deploy <recipe.ts> --yes    # converge
```

Every resource observes live state, so a file you hand-edited after machine-run
wrote it is detected and corrected. Effect gives the whole thing typed errors
(a missing `op` CLI, a symlink source that doesn't exist, malformed package
manager output) instead of a script dying three steps in.

## Quickstart

```sh
./bootstrap.sh          # Node + npm (default)
./bootstrap.sh --bun    # opt in to bun
./bootstrap.sh --deno   # opt in to deno (unverified)
```

```sh
node_modules/.bin/alchemy plan   <recipe.ts>          # preview; changes nothing
node_modules/.bin/alchemy deploy <recipe.ts> --yes    # converge
```

machine-run is the framework and carries nobody's real values. Your name,
email, SSH hosts, package lists and secret references belong in a **separate,
private repo** that depends on this one.

Two examples, with different jobs:

- [`examples/example-machine`](./examples/example-machine/alchemy.run.ts) — a
  small recipe meant to actually run, carrying only resources that need no
  vault, tailnet or prior hand-cleanup.
- [`examples/complete-machine`](./examples/complete-machine) — every resource
  kind exercised once, as compiled code. A reference to copy from, not a
  machine to deploy. `packages/machine/test/ExampleCoverage.test.ts` fails if a
  new resource kind lands without a call there.

## What's here

| Package | Provides |
| --- | --- |
| `@machine-run/core` | `MachinePaths` (`~` expansion), `Backups`, `FileLock`, `Sh` (shell quoting), hashing |
| `@machine-run/engine` | `Reconciler` → Alchemy provider; where drift detection, locking, snapshotting and removal policy are decided once |
| `@machine-run/machine` | one aggregate `providers()` layer, so a recipe cannot forget one |
| `@machine-run/dotfiles` | `File`, `ManagedBlock`, `Symlink`, `Directory`, `Download`, `Exec` |
| `@machine-run/secrets` | `SecretFile` over a `SecretBackend` seam: 1Password, Doppler, Keychain, `pass`, env |
| `@machine-run/system-packages` | `Package` / `Repo` across 19 managers: brew, cask, MacPorts, mas, apt, dnf, pacman, yay, paru, flatpak, snap, winget, choco, cargo, npm, pipx, uv-tool, gem, go-install |
| `@machine-run/system-settings` | `Setting` over `gsettings` / `dconf` |
| `@machine-run/system-services` | `Service` over `launchd` / `brew-services` / `systemd-user`, user-level only |
| `@machine-run/macos-defaults` | `MacOS.Default`, full property-list values including arrays, dicts and data |
| `@machine-run/runtimes` | `Runtime.Tool` over mise, asdf, rustup, uv — installed and active tracked separately |
| `@machine-run/shell` | rc-file rendering across zsh, bash, fish, nu, pwsh; `Shell.Login` (`chsh`) |
| `@machine-run/git` | `Git.Config`, `Git.Repo`, and compositions for ignore/attributes/aliases/signing/credentials/hooks/personas |
| `@machine-run/ai` | `Ai.Skill`, `Ai.Config`, and `Ai.McpServer` across AI coding CLIs |
| `@machine-run/tailscale` | `Tailscale.Connection` |
| `@machine-run/ssh` | `sshHost()` — one `Host` block in `~/.ssh/config` |

## Two ideas do most of the work

**Resources are reconcilers.** A resource says what it manages (`address`),
what's actually there (`observe`), what should be (`desired`), whether that's
close enough (`matches`), and how to converge (`apply`). `toProvider` turns
that into an ordinary Alchemy provider, and decides the uniform parts — drift
detection, write serialisation, snapshot-before-overwrite, plan-vs-apply
capability — in one place instead of once per resource.

**Backends are a seam.** Supporting a new package manager or secret store means
one small module implementing one interface, plus an id. Never a new resource
type, and never a special case inside a generic resource.

## Atomic and manifest layers

A resource is one package, one file, one setting — never a resource that owns a
list. `packages(manager, names)` is a composition-time loop over N independent
resources, not a bundle.

That rule governs *invented* aggregates. It does not forbid modelling a real
ecosystem artifact that has its own identity and its own idempotent apply — a
`Brewfile`, a `mise.toml` — which is a separate, complementary layer. See
[docs/V1-PLAN.md](./docs/V1-PLAN.md).

## Docs

- [docs/MAP.md](./docs/MAP.md) — **start here.** Every package, resource, backend
  and seam, what is verified versus merely written, what is planned and does not
  exist, and the callstack one `plan` travels
- [docs/V2-PLAN.md](./docs/V2-PLAN.md) — where things stand now, and what
  comes next
- [docs/V1-PLAN.md](./docs/V1-PLAN.md) — the first-principles map of what a
  machine actually has, and how the breadth was chosen
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — how it is built
- [docs/CONCEPTS.md](./docs/CONCEPTS.md) — what each Effect and Alchemy concept
  is used for here, and when not to reach for it
- [docs/SYSTEM-DESIGN.md](./docs/SYSTEM-DESIGN.md) — why, with the tradeoffs
- [docs/TASKS.md](./docs/TASKS.md) — the backlog
- [AGENTS.md](./AGENTS.md) — rules for anyone (human or agent) changing this

## License

`UNLICENSED` pending a real choice before any public release.
