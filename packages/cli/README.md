# `@machine-run/cli`

The `machine-run` binary. It builds and renders a recipe's plan without going
through `alchemy`'s own CLI, supplying `AlchemyContext`/`Cli`/`FileSystem`/
`Path` from outside the layer ordering `Stack.evalStack` would otherwise need
internally (see `Engine.ts`). Whatever the outcome, it guarantees the tool
prints _something_ and exits non-zero on failure — a silent success on total
failure is explicitly the thing this exists to never do again. Not a resource
package.

## What it exports

| Export                                                  | What it's for                                                                                                                                                                     |
| --------------------------------------------------------| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin.ts`                                                 | The `machine-run` executable (`package.json`'s `bin`) — imports `Cli.ts`'s command tree and runs it against real argv                                                             |
| `Cli.ts` (`machineRun`)                                  | The `plan`/`deploy`/`destroy` command tree, kept apart from `bin.ts` so tests can run it against explicit argv instead of the test process's own                                  |
| `planRecipe`/`deployRecipe`/`destroyRecipe` (`Commands.ts`) | Load a recipe and run it through Alchemy's plan/apply/destroy machinery — without going through `alchemy`'s own CLI                                                            |
| `Recipe.ts`                                              | Resolves a recipe file path and loads its default export as a compiled `Stack`                                                                                                    |
| `Engine.ts` (`withStackServices`)                        | Supplies `AlchemyContext`/`Cli`/`FileSystem`/`Path` from outside, working around the layer-ordering bug described in [TASKS.md](./TASKS.md)                                       |
| `Diagnostics.ts` (`runToExit`, `describeExit`)           | Runs an effect to completion (or a deadline) and turns any outcome — success, typed failure, or an Effect `Die` defect — into an exit code and message, so nothing exits silently |

## Example

```sh
machine-run plan                       # plans ./alchemy.run.ts, stage "dev"
machine-run plan ./my-recipe.ts --stage prod --deadline-seconds 120

# deploy/destroy mutate a real machine, so both refuse without --yes,
# naming the recipe and stage in the refusal.
machine-run deploy --yes
machine-run destroy ./my-recipe.ts --stage prod --yes
```

(from `packages/cli/src/Cli.ts`'s own `--help` text.)

## Verification status

`Diagnostics.test.ts` covers the exit-code/message contract in isolation.
`planRecipe` is exercised end-to-end by `scripts/deploy-check.sh`, which runs a
real `plan` → `deploy` → empty-second-plan → drift → `destroy` cycle in a
container — see [../../docs/MAP.md](../../docs/MAP.md).

## What it deliberately does not do

- **No interactive confirmation prompt.** `deploy`/`destroy` require `--yes`
  instead of prompting, deliberately — a flag is testable headlessly, a prompt
  isn't. `scripts/container/entrypoint.sh` already passes `--yes` to Alchemy's
  own binary for the same reason.
- **Does not call `Alchemy.deploy`/`Alchemy.destroy` directly.** Those
  exports pin the stack's error type to `ConfigError`; this package's `Recipe`
  type doesn't. `deployRecipe`/`destroyRecipe` build the same
  `Stack.evalStack` + `Plan` + `Apply.apply` shape those exports use
  internally, rather than fighting that signature.
- **Does not vendor or patch around Alchemy's CLI itself.** It calls Alchemy's
  `Stack.evalStack`/`Plan.make`/`formatPlanLines` directly rather than
  reimplementing plan rendering, per [../../AGENTS.md](../../AGENTS.md) rule 1.

See [TASKS.md](./TASKS.md) for the rest of the backlog.
