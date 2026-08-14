import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ConfirmationRequired, deployRecipe, destroyRecipe } from "../src/Commands.ts";
import { RecipeIsStackReference } from "../src/Recipe.ts";

/**
 * `deploy`/`destroy` mutate a real machine, so what's testable here is the
 * refusal path and the recipe-validation path — never a real apply. See
 * `Recipe.test.ts` for the stack-reference detection itself; these tests only
 * confirm `deployRecipe`/`destroyRecipe` still hit it before doing anything
 * that touches the machine.
 */

it.effect("deploy refuses without --yes, before the recipe is even resolved", () =>
  Effect.gen(function* () {
    // A path that does not exist: if confirmation ran *after* resolving the
    // recipe, this would fail with `RecipeNotFound` instead.
    const error = yield* deployRecipe({
      recipe: "/definitely/does/not/exist/machine.run.ts",
      stage: "dev",
      yes: false,
    }).pipe(Effect.flip);

    expect(error).toBeInstanceOf(ConfirmationRequired);
    // `deployRecipe`'s declared error type is `unknown` — the check above
    // already failed the test if this doesn't hold, so this is a guard for
    // the type checker, not a second assertion.
    if (!(error instanceof ConfirmationRequired)) return;
    expect(error.message).toContain("/definitely/does/not/exist/machine.run.ts");
    expect(error.message).toContain("deploy");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("destroy refuses without --yes, and its message is blunt about what it deletes", () =>
  Effect.gen(function* () {
    const error = yield* destroyRecipe({
      recipe: undefined,
      stage: "prod",
      yes: false,
    }).pipe(Effect.flip);

    expect(error).toBeInstanceOf(ConfirmationRequired);
    if (!(error instanceof ConfirmationRequired)) return;
    expect(error.message).toContain("prod");
    expect(error.message).toContain("deletes every resource");
    // No recipe was given, so nothing filesystem-specific should be named.
    expect(error.message).toContain("the default recipe in this directory");
  }).pipe(Effect.provide(NodeServices.layer)),
);

/** The shape `Output.stackRef` produces — see `Recipe.test.ts` for the full explanation. */
const STACK_REFERENCE_MODULE = `
export default Object.assign(
  { kind: "StackRefExpr", stack: "example-machine", stage: undefined },
  { pipe() { return this; } },
);
`;

const writeRecipe = (dir: string, name: string, body: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(dir, name);
    yield* fs.writeFileString(file, body);
    return file;
  });

it.effect("deploy still rejects a stack-reference recipe, even with --yes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const file = yield* writeRecipe(dir, "ref.mjs", STACK_REFERENCE_MODULE);

    // `--yes` grants consent to mutate the machine; it must not also grant
    // an exemption from the recipe being a valid stack in the first place.
    const error = yield* deployRecipe({ recipe: file, stage: "dev", yes: true }).pipe(Effect.flip);

    expect(error).toBeInstanceOf(RecipeIsStackReference);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("destroy still rejects a stack-reference recipe, even with --yes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const file = yield* writeRecipe(dir, "ref.mjs", STACK_REFERENCE_MODULE);

    const error = yield* destroyRecipe({ recipe: file, stage: "dev", yes: true }).pipe(Effect.flip);

    expect(error).toBeInstanceOf(RecipeIsStackReference);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
