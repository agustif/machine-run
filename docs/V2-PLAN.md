# machine-run → v2

[V1-PLAN.md](./V1-PLAN.md) asked "what does a personal-machine reconciler have
to cover, and what is missing". Most of that answer got built: fourteen packages,
a uniform reconciler engine, backend seams for packages, secrets, settings,
shells, runtimes, AI tooling and git, all verified against real systems.

[MAP.md](./MAP.md) is the inventory that goes with this plan: what exists, what
is verified against a real system, and what is still only planned.

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

### Root cause, part one: found and worked around

`Stack.evalStack` wires its platform layer as
`Layer.provideMerge(alchemy(dev), platform)` — it provides `platform` **to** the
layer that produces `AlchemyContext`. But `platform` contains
`Logger.layer([fileLogger("out")])`, and `fileLogger` opens with
`yield* AlchemyContext` to find the `.alchemy` directory to log into, while
`AlchemyContextLive` in turn needs the `FileSystem` and `Path` that `platform`
supplies. Circular, and fatal before any resource is looked at:

```
Error: Service not found: alchemy/Context
    at alchemy/src/Stack.ts:307
    at alchemy/src/Util/FileLogger.ts:7
```

That is why it reproduces identically for a stack with zero resources,
`providers: Layer.empty`, and no machine-run import — the failure is in
Alchemy's own wiring, not in anything a recipe contains.

`@machine-run/cli` works around it by supplying both services from outside
`evalStack`, which needs no change to Alchemy.

### Root cause, part two: still open

Past that, the original defect remains:

```
Fiber.runLoop: Not a valid effect: undefined
```

Something in the plan path yields a non-Effect. Ruled out so far: a missing
provider (`findProviderByType` dies with a clear message), `providerForMode`'s
unchecked `modes` index (our providers carry no `modes`, so that branch never
runs), and `Logger.layer` receiving an Effect (its signature accepts one).

**The silence is a separate bug and arguably the worse one.** A defect thrown
inside the fiber's run loop can leave the driving promise unsettled. The event
loop then drains and **Node exits 0 having printed nothing** — verified with a
minimal one-resource stack: no output, no uncaught exception, no unhandled
rejection, exit code 0, and an `Effect.timeout` that never fired because the
timeout lived in the fiber that died. A total failure indistinguishable from
success.

`@machine-run/cli` cannot fix that upstream, but it refuses to reproduce it:
every path prints, failure is always non-zero, and a program that never settles
is raced against a plain timer outside Effect and reported as a hang.

---

**Original diagnosis, kept for the record.** `alchemy --version` and `--help`
exit 0, so the CLI works; `plan` specifically dies. Running the CLI's own `main`
effect through `Effect.runPromiseExit` surfaces a `Die` defect:

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

Fourteen packages arrived faster than the invariants tying them together.

- [ ] **Eight naming conventions.** Settle before anything ships — a rename is
      a state-schema break.
- [ ] **`observe` → `Option<State>`.** Written up in
      `packages/engine/TASKS.md` as a single atomic change with the full
      implementer list. It is the largest single contributor to a lint backlog
      that now stands at 671 warnings across seven rules.
- [ ] **Two ways to express a directory** — `directoryMode` props versus
      `Machine.Directory`.
- [ ] **The aggregate layer has no completeness test.** It proves the layer
      resolves; it cannot notice a package was never added. That is precisely
      the failure it exists to prevent. `ExampleCoverage.test.ts` now does the
      equivalent for resource kinds; the layer needs the same.

### 3. Close verification gaps CI can now close

CI has `windows-latest` and `macos-latest` runners, which removed the last
"unreachable target" excuses:

- [x] `winget` / `choco` parsers against captured Windows output. Done, and it
      found a real winget parsing bug — detail in [TASKS.md](./TASKS.md) and
      [MAP.md](./MAP.md#4-the-six-backend-seams).
- [x] `mas`, and the `defaults` read path, against a real macOS runner.
- [x] `snap` — a privileged, systemd-booted container (`docker run
      --privileged --cgroupns=host`, real `systemd` PID 1) reaches `snapd`
      fine; see [MAP.md](./MAP.md#4-the-eight-backend-seams).
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

Not more breadth. Fourteen packages is already more surface than something that
has never executed can honestly support, and every package added before `plan`
works is a package whose `observe`/`apply` has never been run by the engine.

The next new backend should wait until a deploy has happened.
