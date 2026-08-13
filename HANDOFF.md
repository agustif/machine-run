# Handoff — machine-run + machines-agusti

Snapshot as of 2026-08-13. Two repos exist now:

- **`/Users/a/machine-run`** (https://github.com/agustif/machine-run, private) — the generic framework, meant for eventual public release.
- **`/Users/a/machines-agusti`** (https://github.com/agustif/machines-agusti, private) — the personal implementation, depends on machine-run via local `file:` references (not published to npm yet).

## What's actually built (both repos pushed, up to date as of this commit)

- **Atomic resources** (`machine-run/packages/dotfiles`): `Machine.File`, `Machine.ManagedBlock`, `Machine.Symlink` — all back up pre-existing real content on first touch (`.machine-run-backups/<timestamp>/`).
- **`machine-run/packages/system-packages`**: one generic `System.Package` / `System.Repo` resource, seven pluggable backends (brew, brew-cask, port/MacPorts, apt, dnf, pacman, cargo, npm). This replaced an earlier, more monolithic Homebrew-bundle/Cargo-bundle/Npm-bundle design that was called out as "god providers" — that critique was correct and this is the fix.
- **`machine-run/packages/secrets`**: `OnePassword` service + `Machine.SecretFile` (diffs on file-existence only, never content — nothing secret-shaped ever enters Alchemy's unencrypted local state), plus a `Doppler` service for work env-var secrets.
- **`machine-run/packages/{git-identity,ai-tools,macos-defaults,ssh,tailscale,core}`**: as designed earlier — see each package's own doc comments.
- **`machine-run/examples/example-machine`**: generic demo recipe (placeholder values, no personal data).
- **`machines-agusti/{macbook-neo,packages/roles,vault}`**: the real personal recipe. `personalDev`/`workDev`/`headlessServer` are now genericized (no hardcoded name/persona baked into reusable code — though this now lives in the personal repo anyway, so it wouldn't matter as much).
- **Tests**: `@effect/vitest` (real, published, working — proven against the same pattern already used in the author's `effect-money` repo), NOT `alchemy-test` (unpublished, confirmed broken via a real upstream bug — reproduces even pinned to the exact git tag matching the published `alchemy` version, so this isn't a version-skew problem, it's genuinely broken). Current coverage: `packages/core` (hash, backup), `packages/dotfiles` (`ManagedBlock.renderFile` + one integration test), `packages/system-packages` (all 8 backends via fake `CommandExecutor`). **NOT covered**: full Alchemy Resource/Provider lifecycle (diff/reconcile) for any resource — that needs alchemy's own test harness, which doesn't work right now. `Machine.File`/`Machine.Symlink`/`Machine.SecretFile`/`MacOS.Default`/`Tailscale.Connection`/`System.Package`/`System.Repo` have NO direct tests of their `reconcile`/`diff` bodies yet.
- **Runtime**: Node/npm is default; bun/deno are opt-in via `bootstrap.sh --bun`/`--deno`.
- **Nothing has been `alchemy deploy`'d for real, anywhere.** Everything is still at the "code exists, type-checked (as of before the last dependency change), never actually applied" stage.

## Known gaps / unverified

- **`tsc -b` has not been re-run since the last several edits** (system-packages, MacPorts, the node-default `package.json` rewrite) because `node_modules` was deleted for disk space and a fresh install risks failing again (see below). Everything since then has been reviewed by hand, not compiler-verified. Treat as "probably correct, not confirmed."
- **Disk space**: was critically low (~715Mi free on a 228Gi volume) for most of this session. A `mo clean --dry-run` found ~14.79GB of safe, recoverable space (npm cache 11GB, Homebrew cache 401MB, Codex runtimes 1.62GB, Chrome/GoogleUpdater caches ~1.4GB, OrbStack container data 725MB) — nothing personal. Cleanup was handed to a separate agent, not done here.
- **Password manager consolidation**: analysis delivered (recommendation: activate the complimentary 1Password Families membership via Business account → Manage Account → "Claim your free family account" — this solves the actual risk without adding tooling); user is doing this later, not automated.
- **Three background agents were dispatched and may still be running or may have already reported back** — check for their results before redoing this work:
  1. Deep code-quality audit of both repos (adversarial review against Alchemy's own `AGENTS.md` doctrine).
  2. Domain-completeness research (what a "complete personal+work computer setup" tool should cover that this doesn't yet — chezmoi/Nix/Ansible comparison, unknown-unknowns).
  3. This repo's own doc suite (README/ARCHITECTURE/DESIGN/AGENTS/BLUEPRINT/TASKS.md) — should exist by the time you read this; if not, it may still be running.
- **Explicit standing direction from the user**: support as many providers/services/apps/CLIs as realistically possible going forward (more secret backends, more package managers, more AI-tool integrations, eventually other OSes) — always grounded in real fetched docs/APIs, never guessed.
- **The codebase is explicitly considered "thin/shallow" by the user** and needs real breadth, not just the structural correctness that's been the focus so far.

## Immediate next steps, in order

1. Check the three background agents' results (if not already reviewed) and act on their findings.
2. Free real disk space, then do a full `npm install` + `tsc -b` + `vitest run` pass — this has not been possible to verify end-to-end this session.
3. Write the missing resource-lifecycle tests once a working test-harness path exists (or accept the current gap and document it clearly instead of pretending it's covered).
4. Do NOT re-litigate: alchemy-test (confirmed broken, dropped for `@effect/vitest`), the atomic-vs-bundle resource design (settled, this was the correct fix), or the machine-run/machines-agusti repo split (settled, both pushed).
