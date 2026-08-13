import * as Plan from "alchemy/Plan";
import * as Stack from "alchemy/Stack";
import * as Effect from "effect/Effect";
import { formatPlanLines } from "alchemy/Cli/LoggingCli";
import { withStackServices } from "./Engine.ts";
import { loadRecipe, resolveRecipePath } from "./Recipe.ts";

/**
 * Builds the plan for an already-loaded recipe.
 *
 * The return type is stated here rather than inferred because `evalStack`'s
 * signature does not subtract what it provides: its body pipes the caller's
 * effect through `provideFreshArtifactStore` and `Effect.provide(stack.services)`,
 * so `State` and `ArtifactStore` are supplied at runtime, but they remain in the
 * inferred requirements. Asserting once, here, keeps that imprecision at a
 * single named boundary instead of leaking `never` casts through every command.
 */
const planned = (recipe: unknown, stage: string): Effect.Effect<unknown, unknown, never> =>
  Stack.evalStack(recipe as never, (compiled) => Plan.make(compiled as never, {}), {
    stage,
  }) as Effect.Effect<unknown, unknown, never>;

export interface RunOptions {
  /** Recipe path, or `undefined` to look for a default name in the cwd. */
  readonly recipe: string | undefined;
  /** Alchemy stage. Stages keep two deployments of one recipe apart. */
  readonly stage: string;
}

/**
 * Produces the plan for a recipe and renders it.
 *
 * Alchemy's own `formatPlanLines` does the rendering: the plan's shape is
 * Alchemy's to describe, and a second formatter here would drift from it
 * silently. What this owns is everything around it — finding the recipe,
 * wiring the services in an order that works, and reporting a failure rather
 * than exiting quietly.
 */
export const planRecipe = (options: RunOptions) =>
  withStackServices(
    Effect.gen(function* () {
      const path = yield* resolveRecipePath(options.recipe);
      const recipe = yield* loadRecipe(path);
      const plan = yield* planned(recipe, options.stage);
      return formatPlanLines(plan as never);
    }),
  );
