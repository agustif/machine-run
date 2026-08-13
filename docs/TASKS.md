# Tasks

The cross-cutting backlog. Work local to one package lives in that package's
own `TASKS.md`:

| Package | Backlog |
|---|---|
| `core` | [packages/core/TASKS.md](../packages/core/TASKS.md) |
| `engine` | [packages/engine/TASKS.md](../packages/engine/TASKS.md) |
| `dotfiles` | [packages/dotfiles/TASKS.md](../packages/dotfiles/TASKS.md) |
| `secrets` | [packages/secrets/TASKS.md](../packages/secrets/TASKS.md) |
| `system-packages` | [packages/system-packages/TASKS.md](../packages/system-packages/TASKS.md) |
| `macos-defaults` | [packages/macos-defaults/TASKS.md](../packages/macos-defaults/TASKS.md) |

See [V1-PLAN.md](./V1-PLAN.md) for the shape this serves and
[SYSTEM-DESIGN.md](./SYSTEM-DESIGN.md) for the reasoning behind decisions
referenced here. Completed work belongs in the design log, not accumulated here
as a changelog.

---

## P0 — the only thing blocking knowing whether any of this works

**Nothing here has ever been deployed.** Every claim about runtime behaviour is
derived from reading Alchemy's source. Docker is available, so there is no
longer an excuse.

- [ ] **Deploy `examples/example-machine` against a container.**
  - [ ] Image with node and the workspace mounted, `$HOME` inside the container
        so nothing touches a real home directory.
  - [ ] `alchemy plan`, then `alchemy deploy`.
  - [ ] **Plan again and assert it is empty.** That is what idempotence means,
        and the first genuine test of every `observe`.
  - [ ] Drift one resource of each kind — edit a managed file, uninstall a
        package, change a `defaults` key, remove a symlink — and assert the next
        plan detects each. This is the end-to-end proof that live-state
        observation actually works, which no unit test can give.
  - [ ] `alchemy destroy` and assert the machine is untouched (the `retain`
        default).
  - [ ] Record what breaks. Something will.

- [ ] **CI.** Nothing runs on push. Needs `tsc -b`, `vitest`, `oxlint`, and the
      container deploy above. The `fakeExec` pattern already proves backends are
      testable without touching a real system.

---

## P1 — coherence across packages

These are the seams where the codebase currently disagrees with itself.

- [ ] **One naming scheme for resource types.** `Machine.*`, `System.*`,
      `MacOS.*`, `Tailscale.*` are four conventions, and the `Machine`/`System`
      split no longer means anything now that both are reconcilers. A rename is
      a state-schema break, so decide before anything ships rather than after.
- [ ] **One way to express a directory.** `File`, `ManagedBlock` and
      `SecretFile` each take a `directoryMode` and create parents themselves;
      `Machine.Directory` is a second way to say it. Pick one.
- [ ] **One aggregate providers layer.** Forgetting a package's `providers()` in
      a recipe is a silent runtime failure, and nothing statically connects
      "this recipe uses X" to "therefore X's providers must be listed".
- [ ] **A README per package.** Source comments already reference ones that do
      not exist.

---

## P1 — testing

- [ ] **Reconciler tests for every resource.** Build the exported
      `make*Reconciler` and drive `observe`/`matches`/`apply` against a temp
      directory — no engine, no fabricated session. Done for `system-packages`;
      pattern in `packages/core/test/FileLock.test.ts`. Missing for `Symlink`,
      `File`, `SecretFile`, `MacOS.Default`, `Tailscale.Connection`.
- [ ] **Engine tests** — that `diff` is genuinely derived from
      `observe`+`matches`, that snapshots happen on first apply and on adoption
      but not on routine updates, and that two resources sharing an `address`
      serialise.
- [ ] **Container-verified fixtures** for every Linux backend, following the apt
      precedent: run the real tool, capture the real output, use it verbatim.

---

## P1 — Effect-native cleanup

All 25 `oxlint-plugin-effect` rules are enabled; errors are at zero. See
[LINTING.md](./LINTING.md) for the tier policy and the primitive each pattern
migrates toward. The `warn` counts are the backlog:

- [ ] **`noNullish`** — split it. About two thirds are Alchemy's contract
      (`diff` returns `undefined`, attributes are JSON, optional props are `?`).
      The rest are ours: `Reconciler.observe` and `Backups.snapshot` both return
      `T | undefined` by our own choice and should be `Option`. Re-measure after,
      then decide whether the remainder can be `error` with a narrow override.
- [ ] **`noTernary`** — the rule exists because Effect has better control-flow
      primitives, not because ternaries are ugly. Convert each cluster to
      `UndefinedOr.match`, `Boolean.match` or `Match`.
- [ ] **`noConditionalEmptyObjectSpread`** — centralise the omit-a-key pattern
      as one helper in `core`.
- [ ] **`noAs`** — audit for genuine assertions among the `as const`s.

---

## P2 — the missing seams

Each follows the established shape: one interface, one module per
implementation, dispatched from inside one generic resource.

- [ ] **`System.Setting` + `SettingsBackend`** — generalises `MacOS.Default` to
      `defaults` / `gsettings` / `dconf` / registry.
- [ ] **`System.Service` + `ServiceBackend`** — `launchd` / `systemd --user` /
      `brew services`.
- [ ] **`RuntimeBackend`** — `mise` / `asdf` / `rustup` / `uv` / `nvm` /
      `pyenv`. Probably the highest remaining day-one value for a dev machine.
- [ ] **Manifest resources** — `Brew.Bundle`, `Mise.Toml`,
      `Asdf.ToolVersions`, `Nix.Flake`. Atomic and manifest layers are
      complementary (see V1-PLAN §3), but a manifest resource must refuse to
      co-manage a manager the atomic layer is also managing.

---

## P2 — mis-scoped packages

Both are named after the one thing that was needed on the day rather than the
surface they belong to.

- [ ] **`git-identity` → `@machine-run/git`.** `Git.Config` (one global
      key/value, diffed live via `git config --global --get`) subsumes most of
      it; then `Git.Ignore`, `Git.Attributes`, `Git.Alias`, `Git.Signing`
      (nothing signs anything today), `Git.CredentialHelper`, `Git.HooksPath`,
      `Git.Repo`, `Git.Maintenance`.
- [ ] **`ai-tools` → `@machine-run/ai`, with a real seam.** Two frozen arrays
      and a loop today; nothing dispatches. Needs an `AiToolBackend` per tool
      and — the real gap — `Ai.McpServer`, where every tool stores MCP servers
      in a different JSON shape.
- [ ] **`ssh`** — `Ssh.KnownHost`, `Ssh.Key` (generate via Alchemy's `KeyPair`
      or materialise from a vault), agent configuration.

---

## P2 — Windows

The quoting seam (`Sh.pwsh`) exists, which was the real blocker.

- [ ] `Platform` service in `core`.
- [ ] Registry `SettingsBackend`; `bootstrap.ps1`; audit path handling for `/`.
- [ ] Verify `winget`/`choco` against a real target. **Not reachable from
      here** — needs a CI runner or a VM.

---

## P3 — operations & release

- [ ] **Doctor / drift report** — answer "what no longer matches" without
      applying. Now meaningful, since `diff` observes live state.
- [ ] **Import an existing machine** — implement `list` on `System.Package`.
- [ ] **Finish the unmanage story** — `RemovalPolicy` gives the mechanism; which
      resources can honestly reverse themselves is still open (V1-PLAN §5).
- [ ] **License.** `UNLICENSED` with no `LICENSE` file blocks any release.
- [ ] **Publishing** — versioning policy, and validate the `exports` maps
      resolve for a non-workspace consumer. Only ever exercised in this
      workspace.
