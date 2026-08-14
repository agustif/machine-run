import { ArtifactStore } from "alchemy/Artifacts";
import { formatPlanLines } from "alchemy/Cli/LoggingCli";
import * as Plan from "alchemy/Plan";
import * as Stack from "alchemy/Stack";
import { State } from "alchemy/State";
import * as Effect from "effect/Effect";
import { withStackServices } from "./Engine.ts";
import { loadRecipe, type Recipe, resolveRecipePath } from "./Recipe.ts";

/**
 * Drops exactly the two services `Stack.evalStack` supplies internally but does
 * not subtract from its own signature.
 *
 * Its body pipes the caller's effect through `provideFreshArtifactStore` and
 * `Effect.provide(stack.services)`, so `State` and `ArtifactStore` are genuinely
 * present at runtime — but the returned type still lists them, and providing
 * them a second time from outside would build a second state store.
 *
 * The parameter type names the two services exactly, so this cannot silently
 * absorb a *third* requirement someone adds later: a new service in `R` stops
 * matching and becomes a compile error here, which is the entire point of
 * writing it this way rather than asserting at the call site.
 */
const withoutEvalStackInternals = <A, E>(
  effect: Effect.Effect<A, E, State | ArtifactStore>,
): Effect.Effect<A, E, never> =>
  // Genuinely unavoidable: `State`/`ArtifactStore` are provided at runtime by
  // `withStackServices`, but nothing short of a cast tells the type checker
  // that dropping them from `R` here is sound rather than a hole — see the
  // doc comment above for why the parameter type still names both exactly.
  // oxlint-disable-next-line effect/noAs -- named, bounded, documented boundary cast (see AGENTS.md §0b).
  effect as Effect.Effect<A, E, never>;

export interface RunOptions {
  /** Recipe path, or `undefined` to look for a default name in the cwd. */
  readonly recipe: string | undefined;
  /** Alchemy stage. Stages keep two deployments of one recipe apart. */
  readonly stage: string;
}

/** Builds the plan for an already-loaded recipe, requirements intact. */
const planned = (recipe: Recipe, stage: string) =>
  Stack.evalStack(recipe, (compiled) => Plan.make(compiled, {}), { stage });

/**
 * Produces the plan for a recipe and renders it.
 *
 * Alchemy's own `formatPlanLines` does the rendering: the plan's shape is
 * Alchemy's to describe, and a second formatter here would drift from it
 * silently. What this owns is everything around it — finding the recipe,
 * wiring the services in an order that works, and reporting a failure rather
 * than exiting quietly.
 */
export const planRecipe = (options: RunOptions): Effect.Effect<readonly string[], unknown, never> =>
  // Order matters, and the types enforce it: `withStackServices` supplies
  // everything that genuinely can be supplied from outside — `AlchemyContext`,
  // `Cli`, `FileSystem`, `Path` — and only then are the two `evalStack`
  // provides for itself dropped. Narrowing before that point would have
  // silently swallowed those four as well.
  withoutEvalStackInternals(
    withStackServices(
      Effect.gen(function* () {
        const path = yield* resolveRecipePath(options.recipe);
        const recipe = yield* loadRecipe(path);
        const plan = yield* planned(recipe, options.stage);
        return formatPlanLines(plan);
      }),
    ),
  );
