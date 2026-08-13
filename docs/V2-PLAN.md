# machine-run → v2

[V1-PLAN.md](./V1-PLAN.md) asked "what does a personal-machine reconciler have
to cover, and what is missing". Most of that answer got built: sixteen packages,
a uniform reconciler engine, backend seams for packages, secrets, settings,
shells, runtimes, AI tooling and git, all verified against real systems.

This document exists because the question changed. v1 was about **breadth**.
v2 is about the fact that **none of it has ever run**, and about the debts that
breadth created.

---

## The blocker

**`alchemy plan` cannot complete, for any stack, including an empty one.**

Established by bisection and independently reproduced:

| Step | Result |
|---|---|
| Real recipe, 7 resources | exit 1, no output |
| One `Dotfiles.File` | exit 1, no output |
| Zero resources, real providers | exit 1, no output |
| Zero resources, `providers: Layer.empty`, no machine-run import at all | exit 1, no output |
| Same, on the host rather than in a container | exit 1, no output |
| Same, on `effect@4.0.0-beta.107` instead of `rc.108` | exit 1, no output |

So it is not our resources, not our providers, not Docker, not Linux, and not
the effect version.

**What it actually is.** `alchemy --version` and `--help` exit 0, so the CLI
works; `plan` specifically dies. Running the CLI's own `main` effect through
`Effect.runPromiseExit` surfaces a `Die` defect:

```
Fiber.runLoop: Not a valid effect: undefined
```

Instrumenting Effect's fiber loop puts the throw inside `iterateEagerImpl` —
Effect's concurrent iteration, i.e. `Effect.forEach`/`Effect.all` — resumed from
an `effectify`'d filesystem callback. So somewhere in Alchemy's plan path, a
collection is mapped to effects and at least one element's function returns
`undefined` instead of an Effect.

Two distinct upstream bugs:

1. The `undefined` effect in the plan path.
2. **The CLI reports nothing at all** — exit 1, empty stdout *and* stderr, even
   at `--log-level all`. A `Die` defect escapes its error reporting entirely.
   The second bug is arguably worse than the first: it turns a diagnosable
   crash into silence.

Notably, the stack program itself **succeeds** when run directly through
`Effect.runPromiseExit`. Only the CLI's plan path fails.

### The decision this needs

Per `AGENTS.md` §1, Alchemy is a dependency and not a fork, so patching its
internals is out of scope by policy. That leaves three options, and picking one
is a judgement call nobody has made yet:

1. **Report upstream and wait.** Correct, and blocks everything indefinitely.
2. **Bypass the CLI.** The stack effect runs fine standalone, so machine-run
   could drive `Plan`/`Apply` directly rather than shelling out to
   `alchemy plan`. This would let everything downstream be exercised now, at
   the cost of owning a code path Alchemy expects to own.
3. **Bisect Alchemy versions** to find one whose `plan` completes, and pin it.
   Cheapest to try; `beta.67` predates our `beta.72` pin and was never tested
   for this.

Option 3 first, then 2 if it fails. Option 1 regardless, since the silent
error reporting is worth reporting whatever we do.

---

## What v2 is actually about

### 1. Prove the model, on one machine

Everything below is downstream of a working `plan`. In order:

- [ ] `plan` completes against the container recipe.
- [ ] `deploy` converges.
- [ ] **`plan` again is empty.** Idempotence, and the first genuine test of
      every `observe` in the codebase.
- [ ] Drift one resource of each kind and see the next plan detect it. No unit
      test can substitute for this.
- [ ] `destroy` leaves the machine untouched (`retain` is the default).

### 2. Pay down what breadth cost

Sixteen packages arrived faster than the invariants tying them together.

- [ ] **Eight naming conventions.** Settle before anything ships — a rename is
      a state-schema break.
- [ ] **`observe` → `Option<State>`.** Written up in
      `packages/engine/TASKS.md` as a single atomic change with the full
      implementer list. It is the largest single contributor to a lint backlog
      that grew from ~150 to ~660 warnings as packages landed.
- [ ] **Two ways to express a directory** — `directoryMode` props versus
      `Machine.Directory`.
- [ ] **Delete the `git-identity` and `ai-tools` shims.**
- [ ] **The aggregate layer has no completeness test.** It proves the layer
      resolves; it cannot notice a package was never added. That is precisely
      the failure it exists to prevent.

### 3. Close verification gaps CI can now close

CI has `windows-latest` and `macos-latest` runners, which removes the last
"unreachable target" excuses:

- [ ] `winget` / `choco` parsers against captured Windows output.
- [ ] `mas`, and the `defaults` read path, against a real macOS runner.
- [ ] `snap` — needs systemd, so a container is not enough; a VM or a runner
      with systemd is required.
- [ ] nu's chdir hook *firing* (registration is verified; firing needs a TTY).
- [ ] `tailscale status --json`'s real shape.
- [ ] `Git.Signing` end to end — nothing in the repo signs anything yet.

### 4. Make it usable by someone who is not its author

- [ ] A license. `UNLICENSED` with no `LICENSE` file blocks any release.
- [ ] Validate the `exports` maps resolve for a real non-workspace consumer.
      They have only ever been exercised inside this workspace.
- [ ] A README per package.
- [ ] A `machines-<you>` template repo, since the split is the intended usage
      and nothing demonstrates it.

---

## What v2 is not

Not more breadth. Sixteen packages is already more surface than something that
has never executed can honestly support, and every package added before `plan`
works is a package whose `observe`/`apply` has never been run by the engine.

The next new backend should wait until a deploy has happened.
