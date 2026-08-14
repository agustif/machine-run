import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Boolean from "effect/Boolean";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { planRecipe } from "./Commands.ts";
import { DEFAULT_DEADLINE_MILLIS, describeExit, withDeadline } from "./Diagnostics.ts";

/**
 * `machine-run` — plans a recipe without going through `alchemy plan`.
 *
 * This exists because Alchemy's CLI cannot currently complete a plan for any
 * stack, including an empty one, and reports nothing at all when it fails:
 * exit 1, empty stdout, empty stderr, even at `--log-level all`. Two distinct
 * faults are behind that, both recorded in `docs/V2-PLAN.md`. One of them —
 * the layer ordering that makes `AlchemyContext` unavailable to the very
 * platform layer that needs it — this works around, in `Engine.ts`. The other
 * is not ours to fix.
 *
 * Whatever happens, this prints something and exits non-zero on failure. A
 * silent exit 0 on a total failure is the single worst behaviour a tool like
 * this can have, and it is the behaviour that made the underlying bug take so
 * long to find. `NodeRuntime.runMain`'s teardown forces the process to exit on
 * any non-zero code rather than waiting for the event loop to drain, which
 * matters here: the defect this package exists to survive leaves Alchemy's own
 * concurrent plan path with hundreds of un-settled sibling fibers, and without
 * that forced exit the process would sit there anyway even after the correct
 * `Exit` had already been produced and printed.
 */
const plan = Command.make(
  "plan",
  {
    recipe: Argument.string("recipe").pipe(
      Argument.optional,
      Argument.withDescription("Path to a recipe; defaults to ./alchemy.run.ts or ./machine.run.ts"),
    ),
    stage: Flag.string("stage").pipe(
      Flag.withDefault("dev"),
      Flag.withDescription("Deployment stage"),
    ),
    deadlineSeconds: Flag.integer("deadline-seconds").pipe(
      Flag.withDefault(DEFAULT_DEADLINE_MILLIS / 1000),
      Flag.withDescription("Report a hang after this long, in seconds"),
    ),
  },
  Effect.fn(function* ({ recipe, stage, deadlineSeconds }) {
    const program = withDeadline(
      planRecipe({ recipe: Option.getOrUndefined(recipe), stage }),
      deadlineSeconds * 1000,
    );
    yield* Effect.onExit(program, (exit) => {
      const described = describeExit(exit, (lines: readonly string[]) =>
        Boolean.match(lines.length === 0, {
          onTrue: () => "No changes.",
          onFalse: () => lines.join("\n"),
        }),
      );
      return Console.log(described.text);
    });
  }),
).pipe(
  Command.withDescription("Plan a recipe (finds ./alchemy.run.ts or ./machine.run.ts by default)"),
);

const machineRun = Command.make("machine-run").pipe(
  Command.withDescription("reconcile this machine from a recipe"),
  Command.withSubcommands([plan]),
);

machineRun.pipe(
  Command.run({ version: "0.0.0" }),
  Effect.provide(NodeServices.layer),
  // The command handler already renders every outcome via `describeExit`, so
  // the default runner's own error logging would only repeat it.
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
