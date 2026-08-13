# machine-run

A personal-machine-setup framework built on [Alchemy](https://alchemy.run) (a
TypeScript Infrastructure-as-Code engine) and [Effect](https://effect.website).
It treats your laptop or server the way Alchemy treats a cloud account: every
piece of desired state — a dotfile, an installed package, a macOS default, a
Tailscale connection, a materialized secret — is a typed, reconciled
**Resource**, not a step in a shell script.

> **Status: pre-1.0, dogfooding.** This repo is being exercised daily by its
> author on their own machines (via a separate, private `machines-<you>`-style
> repo — see [The repo split](#the-repo-split) below) before any public
> release. Nothing here has been `alchemy deploy`'d against a real machine as
> part of this repo's own test suite or CI (there is no CI yet), the test
> coverage is honestly partial (see [TASKS.md](./TASKS.md)), and the API will
> keep changing. Do not treat this as "shipped, stable, works everywhere" —
> treat it as an in-progress framework whose design decisions are recorded in
> [DESIGN.md](./DESIGN.md) as they're made.

## Why this exists instead of a shell script

Shell scripts for machine setup are usually one giant, order-dependent,
non-idempotent pile of `brew install` / `defaults write` / `cat >> ~/.zshrc`
lines. They can't tell you what would change before they change it, they
clobber hand-written config they don't understand, and "did this already
run?" is answered by re-running the whole thing and hoping.

Alchemy's core idea — desired state described as typed resources, with a
Provider that knows how to `diff` (what would change) and `reconcile`
(converge reality to that desired state) — normally targets cloud
infrastructure (AWS, Cloudflare, etc.). machine-run applies the exact same
model to a personal machine:

- `npm run plan` shows you what would change, without changing anything.
- `npm run deploy` converges the machine to match your recipe — safe to run
  repeatedly, because every resource's `reconcile` is written to be
  idempotent.
- Effect gives the whole thing typed errors (a missing `op` CLI, a symlink
  source that doesn't exist, malformed package-manager output) instead of a
  shell script dying on an unhandled non-zero exit code three steps in.

## Quickstart

1. Clone this repo, then run the bootstrap script for a fresh machine:

   ```sh
   ./bootstrap.sh          # default: installs/uses Node.js + npm
   ./bootstrap.sh --bun     # opt in to bun instead
   ./bootstrap.sh --deno    # opt in to deno instead (unverified — see bootstrap.sh)
   ```

   Node + npm is the default runtime and package manager for this project,
   not bun — see [DESIGN.md](./DESIGN.md) for why. `bootstrap.sh` also
   installs the right OS package manager first (Homebrew on macOS, or uses
   apt/dnf/pacman as-is on Linux).

2. machine-run itself is just the framework — it has no opinion about *your*
   name, email, SSH hosts, or which packages you want. Your actual machine
   recipes belong in a **separate, private repo** that depends on this one.
   The author's own such repo is `machines-agusti`
   (github.com/agustif/machines-agusti), which currently depends on this
   framework via a local `file:` reference while both are developed together.
   See [`examples/example-machine/alchemy.run.ts`](./examples/example-machine/alchemy.run.ts)
   for a minimal recipe using machine-run's primitives directly (no
   opinionated "roles" layer — that's something you design yourself, suited
   to your own identities).

3. From your own machine's directory (in your own repo):

   ```sh
   npm run plan     # preview — changes nothing
   npm run deploy   # apply for real
   ```

## The atomic-resource principle

Every custom resource in machine-run is **atomic**: one file, one managed
block, one symlink, one installed package, one extra package repository, one
secret file, one macOS default, one Tailscale connection. There is
deliberately no "bundle" resource that owns a list of things — a recipe that
wants five packages installed declares five `System.Package` resources (or
uses the `packages()` loop sugar in `@machine-run/system-packages`, which is
just a `for` loop over the same atomic resource, not a resource of its own).

This mirrors Alchemy's own precedent: Alchemy has no generic
cross-provider "Bucket" or "Package" resource either — `AWS.S3.Bucket` and
`Cloudflare.R2.Bucket` are separate, provider-specific, atomic resources.
machine-run's `System.Package` resource follows the same shape one level
down: one generic resource type, dispatched to a pluggable per-package-manager
backend (see [ARCHITECTURE.md](./ARCHITECTURE.md)), never a monolithic
resource that reconciles "your whole Homebrew bundle" in one opaque step. See
[DESIGN.md](./DESIGN.md) for the earlier, more monolithic design this
replaced.

## What's here

Nine packages under `packages/*`, each an npm workspace:

| Package | What it provides |
| --- | --- |
| `@machine-run/core` | Shared helpers: `backupIfExists`, `sha256` — no resources of its own |
| `@machine-run/dotfiles` | `Machine.File`, `Machine.ManagedBlock`, `Machine.Symlink` |
| `@machine-run/secrets` | `Machine.SecretFile`, plus live 1Password/Doppler secret sources |
| `@machine-run/system-packages` | `System.Package` / `System.Repo` across 8 package-manager backends |
| `@machine-run/macos-defaults` | `MacOS.Default` (`defaults write`) |
| `@machine-run/tailscale` | `Tailscale.Connection` |
| `@machine-run/git-identity` | `gitIdentity()` — composes dotfiles primitives into a git/gh persona |
| `@machine-run/ssh` | `sshHost()` — composes a `~/.ssh/config` `Host` block |
| `@machine-run/ai-tools` | `aiTools()` — symlinks a reviewed subset of AI coding CLI configs |

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the dependency graph between
these, [DESIGN.md](./DESIGN.md) for why they're shaped this way,
[BLUEPRINT.md](./BLUEPRINT.md) for what "done enough for public release"
looks like, and [TASKS.md](./TASKS.md) for the concrete backlog.

## The repo split

machine-run is meant to be released publicly and depended on, not to carry
any one person's real values. Your name, email, SSH hostnames, 1Password
references, and package lists belong in your own private
`machines-<you>` repo, which imports machine-run's packages the same way any
npm consumer would. During dogfooding, that dependency is a local `file:`
path (or workspace-style path) rather than a real npm publish — see
[BLUEPRINT.md](./BLUEPRINT.md) for what has to happen before machine-run
itself is published to npm.

## For AI coding agents

See [AGENTS.md](./AGENTS.md) before touching this codebase — it links to
Alchemy's own `AGENTS.md` doctrine (reconciler shape, typed errors, file
conventions) that this repo's resources follow, plus this repo's own
conventions on top.

## License

Currently `UNLICENSED` (private, pre-release). A real license needs to be
chosen before public release — see [TASKS.md](./TASKS.md).
