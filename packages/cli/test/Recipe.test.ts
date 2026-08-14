import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { loadRecipe } from "../src/Recipe.ts";

/**
 * The regression guard for this repo's longest-lived bug.
 *
 * `Alchemy.Stack<{}>()(name, options, effect)` type-checks and runs, and yields
 * a cross-stack *reference* rather than a stack — `Stack()` with no arguments
 * returns `(stackName) => Output.stackRef(stackName)`, which takes only a name
 * and discards the options and the effect. Every recipe here was written that
 * way, so `plan` never once worked, and the failure surfaced four layers later
 * as `Fiber.runLoop: Not a valid effect: undefined` (see
 * docs/notes/plan-blocker-repro.md for the full chain).
 *
 * These tests write real recipe modules to a temp directory and load them
 * through the real `loadRecipe`, rather than constructing a fake `StackRefExpr`:
 * the thing under test is whether a genuine mis-written recipe is caught, and a
 * hand-built stand-in could agree with the check while disagreeing with Alchemy.
 */
const writeRecipe = (dir: string, name: string, body: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(dir, name);
    yield* fs.writeFileString(file, body);
    return file;
  });

/** The shape `Output.stackRef` produces, written as a module rather than as an
 * object literal in the test, so it travels the same dynamic-import path a real
 * recipe does. */
const STACK_REFERENCE_MODULE = `
export default Object.assign(
  { kind: "StackRefExpr", stack: "example-machine", stage: undefined },
  { pipe() { return this; } },
);
`;

const REAL_STACK_MODULE = `
export default { pipe() { return this; }, services: {}, name: "example-machine" };
`;

it.effect("rejects a recipe that default-exports a stack reference, naming the stack", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const file = yield* writeRecipe(dir, "ref.mjs", STACK_REFERENCE_MODULE);

    const error = yield* loadRecipe(file).pipe(Effect.flip);

    expect(error._tag).toBe("RecipeIsStackReference");
    // The message has to name both the mistake and the fix, because the whole
    // point is that the default failure names neither.
    expect(error.message).toContain("example-machine");
    expect(error.message).toContain("Alchemy.Stack(name, options, effect)");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("accepts a recipe whose default export is not a reference", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    // The dynamic import must use URL encoding, not string concatenation:
    // spaces are common in a user's checkout path and `file://${path}` turns
    // them into an invalid file URL.
    const file = yield* writeRecipe(dir, "real recipe.mjs", REAL_STACK_MODULE);

    // Loading succeeds; whether the value is a *valid* stack is Alchemy's
    // judgement, and this deliberately does not duplicate it.
    const recipe = yield* loadRecipe(file);
    expect(recipe).toBeDefined();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("still rejects a module with no default export", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const file = yield* writeRecipe(dir, "empty.mjs", "export const notDefault = 1;\n");

    const error = yield* loadRecipe(file).pipe(Effect.flip);
    expect(error._tag).toBe("RecipeNotAStack");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
