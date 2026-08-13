# Handoff — machine-run + machines-agusti

Written 2026-08-13 for a fresh session to pick up cleanly. Read this before doing anything else — it tells you what's actually verified vs. still broken, so you don't re-discover (or re-break) the same things.

## Repos

- **`/Users/a/machine-run`** — https://github.com/agustif/machine-run (private). The generic framework, meant for eventual public release.
- **`/Users/a/machines-agusti`** — https://github.com/agustif/machines-agusti (private). The personal implementation; depends on machine-run via local `file:` references (not published to npm — see DESIGN.md for why this is transitional).

**Both repos have uncommitted changes right now** from a bug-fixing pass — see "In-flight fixes" below before assuming the last commit (`2c8b957` in machine-run) reflects current state.

## Critical: nothing has been compiler-verified this entire session

`node_modules` was deleted mid-session for disk space and never fully reinstalled since (~715Mi free out of 228Gi at last check — `mo clean --dry-run` found ~14.79GB of safe, recoverable space, mostly npm cache/Homebrew cache/Codex runtimes/Chrome caches, nothing personal — cleanup was handed to a separate agent, not done here). **The very first thing to do in a fresh session: get disk space, run `npm install` at the machine-run root, then `npm run check` (tsc -b) and `npm run test` (vitest), and treat everything below as "believed correct from careful manual reading + one prior real audit run," not "confirmed."**

## What a real, adversarial code-quality audit found (verified by actually running tsc/tests/installs against commit `2e5c0c8`)

A background agent did a genuinely rigorous pass — read every source file, read Alchemy's own `AGENTS.md` doctrine in full, and mechanically verified claims by running `tsc -b`, `bun run test`, `npm install`, and `bun install` rather than guessing. Full original findings are in this session's transcript; the load-bearing ones and their fix status:

### Fixed in this session (after the audit):
1. **`machines-agusti/macbook-neo/alchemy.run.ts` was missing `Dotfiles.providers()`** in the stack's `providers` merge, even though the recipe uses `Dotfiles.File`/`Dotfiles.ManagedBlock` transitively via `gitIdentity()`. This is the *same bug class* fixed once already in machine-run's own history (see commit `2e5c0c8`'s message) — it had regressed in the sibling repo. **Fixed**: `Dotfiles` is now imported and included in the `providers` array.
2. **`packages/system-packages` failed to compile entirely (43 tsc errors)**. Root cause: every backend factory (`Apt.ts`, `Brew.ts`, `Cargo.ts`, `Dnf.ts`, `MacPorts.ts`, `Npm.ts`, `Pacman.ts`) typed its parameter as the bare `CommandExecutor` class name, which (since it's defined via `Context.Service`) types as the tag/constructor, not the resolved service shape — verified via effect.website docs, the correct type is `Context.Tag.Service<typeof CommandExecutor>`. **Fixed**: added `export type CommandExecutorService = Context.Tag.Service<typeof CommandExecutor>` to `Backend.ts`, all 7 backends + the test file now use it.
3. **`npm install` failed outright** (`EUNSUPPORTEDPROTOCOL — workspace:*`) — npm has never supported the `workspace:` protocol; only pnpm/bun/yarn-berry do. **Fixed**: every internal `"@machine-run/X": "workspace:*"` (and `machines-agusti`'s `"@machines-agusti/roles": "workspace:*"`) changed to `"*"`, which npm/pnpm/bun all resolve correctly against a local workspace member. This should also resolve the `bun install` failure the audit hit when installing `machines-agusti` (bun couldn't resolve a linked package's own `workspace:*` deps from outside that package's original workspace root) — **not yet re-verified end-to-end, disk space pending.**
4. **`packages/dotfiles/test/File.test.ts` and `Symlink.test.ts` still imported from `"alchemy-test"`/`"alchemy/Test/Alchemy"`**, both removed as dependencies in the prior commit — these two files were missed when `ManagedBlock.test.ts` was migrated. **Fixed**: rewritten using `@effect/vitest` + `NodeServices.layer`, but see the honesty caveat below — they now test the underlying FileSystem operations these resources perform, not the wired-up `FileProvider()`/`SymlinkProvider()` reconcile functions themselves (couldn't verify a `Provider.findProvider`-style direct-invocation approach without a working compiler; safer to ship tests I'm confident are correct than guess at another unverified API).
5. **`@effect/platform-node@4.0.0-beta.102` exports no `NodeContext`** — confirmed via the audit's own `node -e "import(...)"` check; the real export is `NodeServices`. **Fixed** in `core/test/backup.test.ts` and `dotfiles/test/ManagedBlock.test.ts`.
6. **Security: `packages/tailscale/src/Connection.ts` was interpolating the raw 1Password-sourced Tailscale auth key directly into a `shell:true` command string** — leaked into process argv (visible via `ps`) and into any `CommandError`'s message (alchemy's own redaction only scrubs values passed via `env`+`Redacted`, which this didn't use). **Fixed**: auth key now passed via `env: { TS_AUTHKEY: Redacted.make(authKey) }`, referenced as `$TS_AUTHKEY` in the command. Same commit also fixed **finding: reconcile was fabricating its return value** — if already connected but `hostname` changed, it silently skipped applying anything yet still returned the new hostname as if applied; now it runs `tailscale set --hostname=...` in that case.
7. Removed stale `lib/` build output across all `system-packages/*` directories (reflected the old, broken types — would have masked the fix above if left in place and somehow picked up by a stale build).

### NOT fixed yet — still open, in priority order:

- **`packages/macos-defaults/src/Default.ts`** (lines ~55, 63) — `defaults write`/`killall` both run with `shell: true` and unescaped interpolation of `domain`/`key`/`value`/`restartApp`. Low risk today (values are recipe literals) but inconsistent with how `system-packages` backends deliberately avoid `shell:true`. Should either drop `shell:true` (these commands don't need a shell) or escape properly.
- **`packages/secrets/src/OnePassword.ts`** (line ~75) — `ref.replace(/"/g, '\\"')` only escapes double quotes; inside a double-quoted `shell:true` string, `$()` and backticks are still live. Low real-world risk (ref is normally a recipe literal) but should be hardened the same way the Tailscale fix did (route through `env`+`Redacted` instead of string interpolation).
- **`packages/dotfiles/src/File.ts` and `ManagedBlock.ts` — `diff` never reads live disk state**, only compares against this resource's own previously-recorded `output.hash`. If the real file drifts (hand-edited after machine-run wrote it) without a props change, `diff` sees nothing to fix and it's never corrected — a real violation of Alchemy's own "observation > assumption" doctrine. `Symlink.ts` in the same package does this correctly (re-reads the live symlink every diff) — so this is also an internal inconsistency worth fixing to match.
- **`packages/dotfiles/src/Symlink.ts`** — `currentTarget` converts *any* `readLink` failure (including real permission errors) into "not a symlink yet" via `Effect.option`, masking genuine I/O problems as normal absence.
- **`packages/secrets/src/Doppler.ts` is fully unwired dead code** — implemented, never added to `secrets/Providers.ts`, never consumed anywhere, despite its own docstring implying it's one of two integrated secret backends.
- **Undocumented load-bearing ordering** in `machines-agusti/macbook-neo/alchemy.run.ts`: `personalDev` (broad `pathGlob`) must be yielded before `workDev` (narrower `pathGlob`) — `ManagedBlock` appends, and git's `includeIf` is last-stanza-wins, so reordering these would silently make the wrong identity win with no type error. Not documented anywhere in `git-identity/src/Identity.ts`.
- **`noUnusedLocals`/`noUnusedParameters` are `false`** in `tsconfig.base.json` — this is exactly the setting that let the `Dotfiles.providers()` dangling-reference bug (both times) slip past the compiler. Worth turning on, but requires cleaning up currently-unused imports across the codebase first (there are some, e.g. `AiTools`/`sshHost`/`VAULT_DIR` in `macbook-neo/alchemy.run.ts`, used only in comments).
- **Zero test coverage** for: the actual `System.Package`/`System.Repo`/`Machine.SecretFile`/`MacOS.Default`/`Tailscale.Connection` resource providers' diff/reconcile bodies (only the package-manager *backends* they dispatch to are tested), `OnePassword`, `gitIdentity()`, `sshHost()`, `aiToolSkills`/`aiToolConfigFiles`, `detectSystemPackageManager`, `bulk.ts`'s `packages()`/`repos()`. `machines-agusti` has no test infrastructure at all. This is a known, accepted gap (documented in TASKS.md) blocked on either extracting resources' reconcile bodies into standalone testable functions, or a working Alchemy test harness (currently broken upstream).

## Docs suite

A separate background agent wrote `README.md`, `ARCHITECTURE.md`, `DESIGN.md`, `AGENTS.md`, `BLUEPRINT.md`, `TASKS.md` at `/Users/a/machine-run/` root — read them, they're thorough and were written after reading the full codebase + git history + Alchemy's own `AGENTS.md`. **`TASKS.md` in particular is the real backlog — check it before re-deriving priorities.** Note: these docs were written *before* the fixes above, so they may describe some of the now-fixed bugs as still-open — reconcile against this file, this file is more current.

## Standing direction from the user (don't re-litigate)

- Support as many providers/services/apps/CLIs as realistically possible over time (more secret backends, more package managers beyond the current 8, more AI-tool integrations, eventually other OSes) — always grounded in real fetched docs/APIs, never guessed.
- Node.js + npm is the default runtime/package manager; bun/deno are explicit opt-ins (`bootstrap.sh --bun`/`--deno`). Settled, don't revert.
- Atomic resources only, no "bundle" resources that own a list of things. Settled — this was an explicit correction from an earlier, more monolithic design; alchemy's own resources are the precedent (always one cloud object each, never a resource owning a collection).
- The `alchemy-test` harness is confirmed broken (reproduces even pinned to the exact git tag matching the published `alchemy` version — not a version-skew problem) and unpublished (private, `file:`-only, would never resolve for another user). Dropped in favor of `@effect/vitest`, which is real, published, and already proven working in the user's own `effect-money` repo. Don't re-attempt alchemy-test (git submodule was also considered and rejected for the same "still broken regardless" reason).
- The codebase is explicitly considered **thin/shallow** by the user and the machine it was developed against is a nearly-empty new laptop, not representative of a full daily-driver setup — don't assume current scope is "done," breadth is the explicit next priority once correctness is solid.

## Immediate next steps, in order

1. Get real disk space (separate agent handling this).
2. `npm install` at machine-run root, then `npm run check` + `npm run test` — this is the actual moment of truth for everything claimed "fixed" above.
3. Fix whatever that reveals (there will likely be something — nothing here has been compiler-verified).
4. Work through the "NOT fixed yet" list above, in the order given.
5. Re-run the code-quality audit (or do it yourself) against the fixed state to catch anything new.
6. Only then consider new breadth (more backends/providers) — correctness first.
