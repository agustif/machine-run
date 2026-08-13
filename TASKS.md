# Tasks

A concrete, prioritized backlog — not a vague roadmap. Checked items are done;
everything else is open. See [BLUEPRINT.md](./BLUEPRINT.md) for the broader
shape this backlog serves, and [DESIGN.md](./DESIGN.md) for the reasoning
behind decisions referenced below.

## P0 — correctness/repo-hygiene bugs blocking a clean baseline

- [ ] Fix `packages/dotfiles/test/File.test.ts` and
      `packages/dotfiles/test/Symlink.test.ts` — both still import from
      `"alchemy-test"` and `"alchemy/Test/Alchemy"`, neither of which is a
      listed dependency in `package.json` anymore (removed in commit
      `2e5c0c8` when `ManagedBlock.test.ts` was migrated to `@effect/vitest`,
      but these two files were missed). `vitest.config.ts`'s include glob
      (`packages/**/test/**/*.test.ts`) picks both up, so `npm test` will
      fail at collection once `npm install` is actually run. Rewrite them in
      the `@effect/vitest` style (see `dotfiles/test/ManagedBlock.test.ts`
      and `core/test/backup.test.ts` for the pattern) or fold their coverage
      into direct provider-logic tests.
- [ ] Actually run `npm install` + `npm test` + `npm run check` against this
      exact dependency set at least once and fix whatever breaks — as of
      this writing there is no `node_modules/` in the repo, so the
      Node/npm-default path described in `README.md`/`bootstrap.sh` has not
      been smoke-tested since the runtime flip away from bun-only.
- [ ] `tsconfig.base.json` still has `"types": ["bun"]`, left over from the
      bun-only era. Decide whether that's still correct now that Node/npm is
      the default runtime, or whether it should be conditional/removed.

## P1 — testing gaps

- [ ] Full resource-lifecycle (`diff`/`reconcile` through the real Alchemy
      engine) integration test coverage — currently **zero** tests exercise
      a deploy → re-deploy → assert-correct-diff cycle for any resource in
      this repo. Blocked on `alchemy-test` (Alchemy's own private test
      harness) stabilizing past its known `queueMicrotask`/
      `AsyncLocalStorage` bug, or on machine-run building its own lightweight
      alternative harness. Track upstream Alchemy's fix; re-evaluate once a
      new `alchemy`/`alchemy-test` version is published.
- [ ] `Doppler`'s error handling has no classification at all — a single
      `DopplerRunFailed` catch-all, unlike `OnePassword`'s three-way
      `classifyFailure` (`OnePasswordCliMissing` /
      `OnePasswordAuthRequired` / `OnePasswordReadFailed`). Decide whether
      Doppler needs the same treatment (CLI-missing vs. not-logged-in vs.
      generic failure) and add it + tests.
- [ ] `OnePassword`'s `classifyFailure` matches raw English CLI stderr
      substrings (`"not signed in"`, `"command not found"`, `"no such
      file"`, `"no valid session"`, `"authentication"`) that have never been
      verified against the real `op` CLI's actual current error text. Add
      fixture-based tests (real captured `op` stderr, not invented strings)
      the way `system-packages/test/backends.test.ts` does for package
      manager output.
- [ ] No test exercises `Machine.SecretFile`, `Tailscale.Connection`, or
      `MacOS.Default`'s provider logic at all (not even with a fake
      `CommandExecutor`) — only `system-packages`'s backends have that level
      of coverage today. Add fake-`CommandExecutor`-backed tests for these
      three resources' `diff`/`reconcile` logic.

## P1 — real-world validation

- [ ] A real `alchemy plan` / `alchemy deploy` dry-run (then a real apply)
      against a live machine — this has never happened anywhere in this
      repo's history. No `.alchemy/state/` directory exists in the tree.
      Start with `examples/example-machine` on a disposable VM or container
      before running against a real personal machine.
- [ ] Once the above works, uncomment and validate
      `examples/example-machine/alchemy.run.ts`'s currently-commented-out
      resources (`Secrets.SecretFile`, `AiTools.aiTools`, `sshHost`,
      `Tailscale.TailscaleConnection`) against a real (test) 1Password vault
      and a real (test) Tailscale account.
- [ ] Write the per-package README files that source comments already
      reference but that don't exist anywhere in the repo: a
      `macos-defaults` README describing the "capture from a real `defaults
      read`" workflow, and an `ai-tools` vault README describing how to
      review and populate `vaultDir`. (`system-packages/src/Repo.ts` also
      references a README for why dnf/pacman repos are out of scope — either
      write it or drop the reference.)

## P2 — provider/backend breadth (the stated pre-release priority)

- [ ] Research and implement more package-manager backends against the
      existing `PackageManagerBackend` interface: AUR helpers (yay/paru),
      Nix/home-manager, Linux desktop formats (flatpak, snap).
- [ ] Research and wire up `System.Repo` support for dnf (COPR) and pacman
      (AUR-as-repo is a stretch; at minimum document why it's out of scope
      if it stays that way).
- [ ] Research and implement more secret backends beyond 1Password/Doppler,
      each as a live `Context.Service` (never a resource whose attributes
      could carry secret bytes into state): Bitwarden CLI, `pass`,
      AWS Secrets Manager, HashiCorp Vault, macOS Keychain.
- [ ] Research and add more AI-tool integrations to
      `@machine-run/ai-tools`'s `AI_TOOL_SKILLS_DIRS`/`AI_TOOL_CONFIG_FILES`
      allowlists as new tools appear — keep the reviewed-allowlist-only
      posture (never a blanket directory symlink).
- [ ] Windows/other-OS support research. Currently zero Windows support
      anywhere: `bootstrap.sh` is POSIX `sh` only, `detectSystemPackageManager`
      (`system-packages/src/detect.ts`) has no `win32` branch, and no backend
      targets winget/scoop/chocolatey. Decide if/when this is worth pursuing
      before or after the initial public release.

## P2 — CI/release

- [ ] Set up CI — there is currently no `.github/` directory or any CI
      config at all in this repo. Needs to be disk-space-safe (installing
      Homebrew/apt packages, running `defaults write`, and shelling out to
      real package managers in tests should either run in a disposable
      container/VM or be mocked — the existing `fakeExecutor` pattern in
      `system-packages/test/backends.test.ts` is the template for what
      should run in CI without touching a real system).
- [ ] Decide the license and add a `LICENSE` file — `package.json` currently
      says `"license": "UNLICENSED"` and no `LICENSE` file exists anywhere in
      the repo. This blocks any real public release.
- [ ] Settle on a version/release policy for publishing `machine-run` to npm
      (currently `"version": "0.0.0"`, `"private": true` in the root
      `package.json`) to replace `machines-agusti`'s local `file:`-based
      dependency with a real semver dependency. Validate the per-package
      `exports` maps (`./lib` for `types`/`import`, `./src` under the `bun`
      condition) actually resolve correctly for an external, non-workspace
      consumer — this has only ever been exercised inside this monorepo's
      own workspace resolution.

## P3 — longer-term / speculative

- [ ] A real doctor/health-check story, once plain `alchemy plan` proves
      insufficient to explain drift — e.g. `MacOS.Default`'s diff-against-
      own-output shortcut (see DESIGN.md) can't detect a live system value
      that changed outside machine-run. No design work has started on this;
      it's a stated future direction, not an in-progress feature.
- [ ] Revisit `MacOS.Default`'s diff strategy: either accept the documented
      drift-blindness permanently, or add an opt-in "verify against live
      `defaults read`" mode and measure the cost.
- [ ] A CHANGELOG and versioning policy once npm publishing is on the table.
