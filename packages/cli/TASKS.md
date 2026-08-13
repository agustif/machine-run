# `@machine-run/cli` — backlog

`machine-run plan` — plans a recipe without going through `alchemy plan`.

## Why this package exists

`alchemy plan` cannot complete for any stack, including an empty one with no
providers and no machine-run import. It fails by exiting 1 with **empty stdout
and empty stderr**, even at `--log-level all`. That silence is the expensive
part: diagnosing it meant running the CLI's own effect by hand and reading
Effect's fiber internals, because there was nothing to read.

Two distinct faults sit behind it, both recorded in
[docs/V2-PLAN.md](../../docs/V2-PLAN.md):

1. **A layer-ordering bug in `Stack.evalStack`.** It wires
   `Layer.provideMerge(alchemy(dev), platform)` — providing `platform` _to_ the
   layer that produces `AlchemyContext`. But `platform` contains
   `Logger.layer([fileLogger("out")])`, and `fileLogger` opens with
   `yield* AlchemyContext` to find the directory to log into, while
   `AlchemyContextLive` needs the `FileSystem` and `Path` that `platform`
   supplies. The result is `Service not found: alchemy/Context` before any
   resource is examined. `src/Engine.ts` works around it by supplying both from
   outside; Alchemy stays a dependency rather than a fork.
2. **An `undefined` reaching Effect's run loop**, surfacing as
   `Fiber.runLoop: Not a valid effect: undefined`. Not diagnosed to a line.
   Ruled out so far: a missing provider (`findProviderByType` dies with a clear
   message instead), `providerForMode`'s unchecked `modes` index (our providers
   carry no `modes`, so that branch is never taken), and `Logger.layer`
   receiving an Effect (its signature explicitly accepts one).

## Open

- [ ] **`deploy` and `destroy`.** Only `plan` exists. `Apply.apply` needs a
      `Cli` service — a three-method interface (`approvePlan`, `displayPlan`,
      `startApplySession`) — so a real implementation is small. Alchemy ships
      `LoggingCli` as a non-TUI option worth reading first, and worth
      suspecting: the Ink TUI is a plausible home for fault 2, since the
      silence is characteristic of a renderer that never mounts.
- [ ] **Move argument parsing to `effect/unstable/cli`.** Deliberately hand-rolled
      while there is one command: the value here is the diagnosis, not the flag
      grammar. Alchemy's own commands are built on that library, so this will
      match them. `Command.make` + `withSubcommands` + `Flag` are the pieces.
- [ ] **Report fault 2 upstream regardless of what we do about it.** A `Die`
      defect escaping with no output is arguably worse than the defect itself,
      and it is cheap for Alchemy to fix.
- [ ] **Test the `plan` path end to end** once a plan can actually complete.
      Today `Diagnostics.test.ts` covers the reporting contract, and nothing
      covers `planRecipe`, because there is no stack it can succeed on.
- [ ] **A recipe that exports the wrong thing** is only partly caught.
      `RecipeNotAStack` catches a missing or primitive default export; it cannot
      tell a compiled stack from any other object without duplicating Alchemy's
      own judgement.
