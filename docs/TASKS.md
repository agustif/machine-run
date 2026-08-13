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
| `runtimes` | [packages/runtimes/TASKS.md](../packages/runtimes/TASKS.md) |
| `machine` | [packages/machine/TASKS.md](../packages/machine/TASKS.md) |

[V2-PLAN.md](./V2-PLAN.md) is the current priority order and explains the
blocker. [V1-PLAN.md](./V1-PLAN.md) is the coverage map.
[SYSTEM-DESIGN.md](./SYSTEM-DESIGN.md) carries the reasoning behind decisions
referenced here. Completed work belongs in the design log, not accumulated here
as a changelog.

---

## P0 — the blocker

**`alchemy plan` cannot complete for any stack, including an empty one with no
machine-run code in it.** Bisected and independently reproduced on two effect
versions, on host and in container. It is an upstream defect (an `undefined`
reaching Effect's fiber loop from Alchemy's plan path) compounded by the CLI
reporting *nothing at all* — exit 1, empty stdout and stderr, even at
`--log-level all`. Detail in [V2-PLAN.md](./V2-PLAN.md#the-blocker).

- [ ] **Decide how to proceed**: bisect Alchemy versions for one whose `plan`
      completes; or drive `Plan`/`Apply` directly and bypass the CLI (the stack
      effect runs fine standalone); or wait on upstream. Report the silent
      error handling upstream regardless.
- [ ] Once unblocked, in order: `plan` → `deploy` → **empty second plan**
      (idempotence, and the first genuine test of every `observe`) → drift each
      resource kind and confirm detection → `destroy` leaves the machine
      untouched.

Everything below is downstream of that.

---

## P1 — debts that breadth created

Sixteen packages arrived faster than the invariants tying them together.

- [ ] **Eight resource-type naming conventions** — `Machine.*`, `System.*`,
      `MacOS.*`, `Tailscale.*`, `Git.*`, `Ai.*`, `Runtime.*`, `Shell.*`. The
      `Machine`/`System` split stopped meaning anything once both became
      reconcilers. A rename is a state-schema break, so settle it before
      anything ships.
- [ ] **`observe` → `Option<State>`** — written up in
      `packages/engine/TASKS.md` as one atomic change with the full implementer
      list. Largest single contributor to a lint backlog that grew from ~150 to
      ~660 warnings as packages landed.
- [ ] **Two ways to express a directory** — `directoryMode` props on `File`,
      `ManagedBlock` and `SecretFile` versus `Machine.Directory`.
- [ ] **The aggregate layer has no completeness test.** It proves the layer
      resolves; it cannot notice a package was never added — precisely the
      failure it exists to prevent.
- [ ] **A README per package.** Source comments already reference ones that do
      not exist.

---

## P1 — Effect-native cleanup

All 25 `oxlint-plugin-effect` rules are enabled and errors are at zero; see
[LINTING.md](./LINTING.md) for the tier policy and the primitive each pattern
migrates toward. The `warn` counts are the backlog, and they grew with each new
package rather than shrinking:

- [ ] **`noNullish`** — split it. Roughly two thirds are Alchemy's contract
      (`diff` returns `undefined`, attributes are JSON, optional props are `?`).
      The rest are ours, chiefly `observe` above.
- [ ] **`noTernary`** — the rule exists because Effect has better control-flow
      primitives, not because ternaries are ugly. `UndefinedOr.match`,
      `Boolean.match`, `Match`.
- [ ] **`noConditionalEmptyObjectSpread`** — centralise the omit-a-key pattern
      as one helper in `core`.
- [ ] **`noAs`** — audit for genuine assertions among the `as const`s.

---

## P1 — verification CI can now close

CI runs on `ubuntu`, `macos` and `windows` runners, which removes the last
"unreachable target" excuses. Each item below is a backend whose doc comment
currently says *unverified*.

- [ ] `winget` / `choco` parsers against captured Windows output.
- [ ] `mas`, and the `defaults` read path, against a real macOS runner.
- [ ] `snap` — needs systemd, so a container is not enough.
- [ ] nu's chdir hook *firing* (registration is verified; firing needs a TTY).
- [ ] `tailscale status --json`'s real shape.
- [ ] `Git.Signing` end to end — nothing in the repo signs anything yet.

---

## P2 — remaining seams

Each follows the established shape: one interface, one module per
implementation, dispatched from inside one generic resource.

- [ ] **`System.Service` + `ServiceBackend`** — `launchd` / `systemd --user` /
      `brew services`. The last major machine surface with no coverage.
- [ ] **Manifest resources** — `Brew.Bundle`, `Mise.Toml`,
      `Asdf.ToolVersions`, `Nix.Flake`. Atomic and manifest layers are
      complementary (V1-PLAN §3), but a manifest resource must refuse to
      co-manage a manager the atomic layer is also managing.
- [ ] **`ssh` breadth** — `Ssh.KnownHost`, `Ssh.Key` (generate via Alchemy's
      `KeyPair` or materialise from a vault), agent configuration.
- [ ] **Windows** — `Platform` service in `core`, registry `SettingsBackend`,
      `bootstrap.ps1`, and an audit of path handling for `/` assumptions.

**Not before a deploy works.** Every package added while `plan` is broken is a
package whose `observe`/`apply` the engine has never run.

---

## P3 — operations & release

- [ ] **Doctor / drift report** — answer "what no longer matches" without
      applying. Meaningful now that `diff` observes live state.
- [ ] **Import an existing machine** — implement `list` on `System.Package`.
- [ ] **Finish the unmanage story** — the mechanism exists and two resources
      implement `unapply`; which of the remaining ~18 can honestly reverse
      themselves is still open (V1-PLAN §5).
- [ ] **License.** `UNLICENSED` with no `LICENSE` file blocks any release.
- [ ] **Publishing** — versioning policy, and validate the `exports` maps
      resolve for a real non-workspace consumer. Only ever exercised inside
      this workspace.
- [ ] **A `machines-<you>` template repo.** The repo split is the intended
      usage and nothing demonstrates it.
