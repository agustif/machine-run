import { ArtifactStore } from "alchemy/Artifacts";
import { formatPlanLines } from "alchemy/Cli/LoggingCli";
import * as Apply from "alchemy/Apply";
import * as Plan from "alchemy/Plan";
import * as Stack from "alchemy/Stack";
import { State } from "alchemy/State";
import * as Boolean from "effect/Boolean";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import * as Path from "effect/Path";
import * as UndefinedOr from "effect/UndefinedOr";
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

/** `deploy`/`destroy` options: everything `plan` needs, plus explicit consent. */
export interface MutatingRunOptions extends RunOptions {
  /** Must be `true`, or the command refuses before touching anything. */
  readonly yes: boolean;
}

/**
 * `deploy` or `destroy` refused because `--yes` was not passed.
 *
 * `destroy`'s message is deliberately blunter: it does not just change the
 * machine, it removes everything this recipe manages on it.
 */
export class ConfirmationRequired extends Data.TaggedError("ConfirmationRequired")<{
  readonly action: "deploy" | "destroy";
  readonly recipe: string;
  readonly stage: string;
}> {
  override get message() {
    const target = `"${this.recipe}" (stage: ${this.stage})`;
    return Match.value(this.action).pipe(
      Match.when(
        "deploy",
        () => `Refusing to deploy ${target} without --yes. Deploying mutates a real machine.`,
      ),
      Match.when(
        "destroy",
        () =>
          `Refusing to destroy ${target} without --yes. Destroying deletes every resource this recipe manages on that machine. Pass --yes only if that is what you want.`,
      ),
      Match.exhaustive,
    );
  }
}

/** Names the recipe for a refusal message, without resolving it against the filesystem. */
const describeRecipe = (recipe: string | undefined): string =>
  UndefinedOr.match(recipe, {
    onUndefined: () => "the default recipe in this directory",
    onDefined: (path) => path,
  });

/**
 * Fails with {@link ConfirmationRequired} unless `options.yes` is set.
 *
 * Deliberately checked before the recipe is even resolved: `withStackServices`
 * creates the `.alchemy` directory as a side effect of merely being provided
 * (see `AlchemyContextLive`), so this has to run first for "no `--yes`" to
 * genuinely mean "nothing happened."
 */
const requireConfirmation = (
  action: "deploy" | "destroy",
  options: MutatingRunOptions,
): Effect.Effect<void, ConfirmationRequired> =>
  Boolean.match(options.yes, {
    onFalse: () =>
      Effect.fail(
        new ConfirmationRequired({
          action,
          recipe: describeRecipe(options.recipe),
          stage: options.stage,
        }),
      ),
    onTrue: () => Effect.void,
  });

/** Builds and applies the plan for an already-loaded recipe — what `alchemy deploy` does. */
const deployed = (recipe: Recipe, stage: string) =>
  Stack.evalStack(
    recipe,
    (compiled) => Plan.make(compiled, {}).pipe(Effect.flatMap(Apply.apply)),
    { stage },
  );

/** Builds and applies the plan that removes every resource — what `alchemy destroy` does. */
const destroyed = (recipe: Recipe, stage: string) =>
  Stack.evalStack(
    recipe,
    (compiled) => Plan.destroy(compiled).pipe(Effect.flatMap(Apply.apply)),
    { stage },
  );

/**
 * Deploys a recipe: refuses without `--yes` (see {@link requireConfirmation}),
 * then resolves and loads the recipe, then applies its plan.
 *
 * Resolving and loading happen *outside* `withStackServices` — unlike `plan`
 * — because neither needs `AlchemyContext`/`Cli`, and keeping them out means
 * a stack-reference recipe (see `RecipeIsStackReference`) is still caught
 * before `withStackServices` builds anything, `.alchemy` directory included.
 */
export const deployRecipe = (
  options: MutatingRunOptions,
): Effect.Effect<string, unknown, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    yield* requireConfirmation("deploy", options);
    const path = yield* resolveRecipePath(options.recipe);
    const recipe = yield* loadRecipe(path);
    yield* withoutEvalStackInternals(withStackServices(deployed(recipe, options.stage)));
    return `Deployed "${path}" (stage: ${options.stage}).`;
  });

/**
 * Destroys a recipe's deployed resources: refuses without `--yes` (see
 * {@link requireConfirmation}), then resolves and loads the recipe, then
 * applies its destroy plan.
 *
 * Same ordering as {@link deployRecipe}, for the same reason.
 */
export const destroyRecipe = (
  options: MutatingRunOptions,
): Effect.Effect<string, unknown, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    yield* requireConfirmation("destroy", options);
    const path = yield* resolveRecipePath(options.recipe);
    const recipe = yield* loadRecipe(path);
    yield* withoutEvalStackInternals(withStackServices(destroyed(recipe, options.stage)));
    return `Destroyed "${path}" (stage: ${options.stage}).`;
  });
