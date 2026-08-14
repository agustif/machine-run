# `@machine-run/cli`

The `machine-run` binary. It exists because `alchemy plan` cannot currently
complete for **any** stack — including an empty one with zero resources and no
machine-run import — and fails by exiting 1 with empty stdout and stderr, even
at `--log-level all`. This package works around the diagnosable half of that
(a layer-ordering bug reachable from outside Alchemy) and, whatever else is
wrong, guarantees the tool prints _something_ and exits non-zero on failure —
a silent success on total failure is explicitly the thing this exists to never
do again. Not a resource package.

## What it exports

| Export                                         | What it's for                                                                                                                                                                     |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin.ts`                                       | The `machine-run` executable (`package.json`'s `bin`) — parses argv, dispatches to `plan`, prints the result                                                                      |
| `planRecipe(options)` (`Commands.ts`)          | Loads a recipe, builds an Alchemy `Plan` for it, and renders the plan lines — without going through `alchemy`'s own CLI                                                           |
| `Recipe.ts`                                    | Resolves a recipe file path and loads its default export as a compiled `Stack`                                                                                                    |
| `Engine.ts` (`withStackServices`)              | Supplies `AlchemyContext`/`Cli`/`FileSystem`/`Path` from outside, working around the layer-ordering bug described in [TASKS.md](./TASKS.md)                                       |
| `Diagnostics.ts` (`runToExit`, `describeExit`) | Runs an effect to completion (or a deadline) and turns any outcome — success, typed failure, or an Effect `Die` defect — into an exit code and message, so nothing exits silently |

## Example

The only command that exists:

```sh
machine-run plan                       # plans ./alchemy.run.ts, stage "dev"
machine-run plan ./my-recipe.ts --stage prod --deadline-seconds 120
```

(from `packages/cli/src/bin.ts`'s own `--help` text.)

## Verification status

`Diagnostics.test.ts` covers the exit-code/message contract in isolation.
`planRecipe` itself has never been exercised end-to-end, because there is no
stack it can currently succeed on — it depends on the same broken `alchemy
plan` path every other package in this repo is blocked by (see
[../../docs/V2-PLAN.md](../../docs/V2-PLAN.md)). The layer-ordering
workaround in `Engine.ts` was diagnosed to a line; a second, undiagnosed fault
(`Fiber.runLoop: Not a valid effect: undefined`) still blocks a plan from
completing even with that workaround in place.

## What it deliberately does not do

- **Only `plan` exists.** `deploy` and `destroy` are not implemented — see
  [TASKS.md](./TASKS.md) for what a `Cli` service implementation would need.
- **No real argument-parsing library.** Argv handling is hand-rolled rather
  than built on `effect/unstable/cli`, deliberately, while there is exactly
  one command — the value this package adds right now is the diagnosis, not
  the flag grammar.
- **Does not vendor or patch around Alchemy's CLI itself.** It calls Alchemy's
  `Stack.evalStack`/`Plan.make`/`formatPlanLines` directly rather than
  reimplementing plan rendering, per [../../AGENTS.md](../../AGENTS.md) rule 1.

See [TASKS.md](./TASKS.md) for the two distinct faults behind the blocked
`alchemy plan`, in detail.
