# Blueprint: what "done enough for public release" looks like

This is a snapshot of where machine-run actually is, honestly, and the shape
of what still needs to happen before it's ready for a stranger to depend on.
The author currently describes this codebase as **thin/shallow** — broad
provider/backend coverage is the explicit stated goal before public release,
not a nice-to-have. See [TASKS.md](./TASKS.md) for the itemized backlog this
blueprint implies.

## What's built now

Nine packages, each an npm workspace under `packages/*`:

- **`@machine-run/core`** — `backupIfExists` (pre-write snapshotting) and
  `sha256` (content hashing). No resources.
- **`@machine-run/dotfiles`** — `Machine.File` (fully-owned generated file),
  `Machine.ManagedBlock` (marker-delimited block inside a file you don't
  fully own), `Machine.Symlink` (whole file/dir symlinked from a reviewed
  source). The foundation every other dotfiles-shaped package composes on.
- **`@machine-run/secrets`** — `Machine.SecretFile` (materializes a 1Password
  secret to a file, diffed on existence only), plus two live secret-source
  services: `OnePassword` (file-shaped secrets) and `Doppler` (env-var
  injection at command launch).
- **`@machine-run/system-packages`** — the generic `System.Package` /
  `System.Repo` resources, dispatched across seven backend modules covering
  eight package-manager IDs (brew, brew-cask, port/MacPorts, apt, dnf,
  pacman, cargo, npm). `Repo` (extra repositories) currently only wires up
  brew (taps) and apt (PPAs).
- **`@machine-run/macos-defaults`** — `MacOS.Default`, one `defaults write`
  setting per resource.
- **`@machine-run/tailscale`** — `Tailscale.Connection`, brings up
  `tailscale` using an auth key read live from 1Password.
- **`@machine-run/git-identity`** — `gitIdentity()`, composes a persona's own
  gitconfig file, an `includeIf` stanza in the shared `~/.gitconfig`, and an
  optional `gh` account-switching zsh hook — all via `dotfiles` primitives,
  not a resource of its own.
- **`@machine-run/ssh`** — `sshHost()`, composes one `Host` block in
  `~/.ssh/config` via `Dotfiles.ManagedBlock`.
- **`@machine-run/ai-tools`** — `aiTools()`, symlinks a hand-picked,
  explicitly-reviewed allowlist of AI coding CLI `skills/` directories and
  config files (12 tools' `skills/` dirs, 6 config files) from a vault
  directory — never a tool's full config directory, to keep credentials out.

Plus `examples/example-machine/alchemy.run.ts`, a demo recipe using these
primitives directly (no opinionated "roles" abstraction layer — that's left
to each user's own private repo).

## What's structurally in place but not yet exercised for real

- **Nothing has been `alchemy deploy`'d, anywhere, as part of this repo.**
  There is no `.alchemy/state/` directory in the tree. The whole system has
  been designed and unit-tested at the logic/backend level but never run
  through a live `plan`/`deploy` cycle against a real machine from within
  this repo's own history.
- `examples/example-machine/alchemy.run.ts`'s most interesting resources are
  literally commented out pending manual, per-user review steps:
  `Secrets.SecretFile` (needs `op signin` + a real item reference),
  `AiTools.aiTools` (needs vault content reviewed and copied in first),
  `sshHost` (needs an old unmanaged `Host` block removed from
  `~/.ssh/config` first), and `Tailscale.TailscaleConnection` (needs a real
  Tailscale account + auth key). Only `gitIdentity`, `SystemPackages.packages`,
  a `Dotfiles.ManagedBlock`, and one `MacOsDefaults.MacDefault` actually run
  in the example as shipped.
- Several source-code doc comments reference per-package README files
  (macos-defaults' "workflow" for capturing `defaults read` values,
  ai-tools' vault README) that **do not exist yet anywhere in this repo.**
- `system-packages`'s `Repo` resource comment says "dnf/pacman are out of
  scope for now — see README," but no such README exists either.
- Nothing in this repo has ever had `npm install` run against the current
  dependency set (no `node_modules` present at time of writing) — the
  Node/npm-default bootstrap path described in `bootstrap.sh` and `README.md`
  hasn't been smoke-tested end-to-end since the runtime flip.

## Intended shape of growth

Stated author intent, verbatim in spirit: support as many providers,
services, apps, and CLIs as realistically possible — more secret backends,
more package managers, more AI-tool integrations, and eventually
non-macOS/Linux platforms — with typing always grounded in real APIs/docs/
code, never guessed or invented. Concretely, that means:

- **More package-manager backends**, following the exact
  `PackageManagerBackend` pattern already established: AUR helpers (yay/
  paru), Nix/home-manager, Linux desktop formats (flatpak, snap), and — if
  Windows support is ever pursued — winget/scoop/chocolatey.
- **More secret backends** beyond 1Password and Doppler, each a live
  service like the existing two, never a resource whose output could carry
  secret bytes into state: Bitwarden CLI, `pass`, AWS Secrets Manager,
  HashiCorp Vault, macOS Keychain.
- **More AI-tool integrations** as that ecosystem grows, following
  `ai-tools`'s reviewed-allowlist-only pattern — never a blanket symlink of
  a tool's entire config directory.
- **Non-macOS/Linux platform consideration** (explicitly "consideration," not
  a commitment yet) — Windows in particular has no story at all right now:
  `bootstrap.sh` is POSIX `sh`, `detectSystemPackageManager` has no `win32`
  branch, and no backend targets a Windows package manager.
- **A real doctor/health-check story, once `alchemy plan` alone proves
  insufficient.** No such feature exists yet — this is a stated future
  direction, not a current gap in something already partially built. If/when
  `plan`'s diff output stops being enough (e.g. to explain *why* a live
  system value drifted from `MacOS.Default`'s memoized output, per DESIGN.md),
  a dedicated doctor/health-check command is the anticipated answer.
- **A real npm publish of `machine-run`**, replacing `machines-agusti`'s
  current local `file:`-based dependency with a real semver dependency. This
  requires: settling on a version/release policy (the package is currently
  `"version": "0.0.0"`, `"private": true`), choosing and adding a real
  license (currently `"license": "UNLICENSED"`, no `LICENSE` file exists),
  and validating the package `exports` maps (`./lib` for consumers, `./src`
  under the `bun` condition) actually work for an external, non-workspace
  consumer.

## What "done enough" is not

This blueprint deliberately does not claim a timeline, a 1.0 feature list, or
that the current 9 packages represent full coverage of "personal machine
setup." The honest current state is: a working atomic-resource model and one
genuinely generalized subsystem (`system-packages`'s backend abstraction),
proven out across 9 packages, none of it yet deployed for real, with broad
provider coverage still to be built out. See TASKS.md for the concrete,
prioritized list.
