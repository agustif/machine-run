import type { AlchemyContext } from "alchemy/AlchemyContext";
import type { Stage } from "alchemy/Stage";
import type * as Stack from "alchemy/Stack";
import { statIfPresent } from "@machine-run/core";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { pathToFileURL } from "node:url";

/**
 * What a recipe file default-exports: the effect `Alchemy.Stack(...)` returns,
 * which evaluates to a compiled stack.
 *
 * Spelled out as Alchemy spells it rather than reduced to `unknown`, so the
 * shape survives all the way to `Stack.evalStack` and a mismatch is a compile
 * error here rather than a cast at the call site.
 */
export type Recipe = Stack.StackEffect<Stack.CompiledStack, unknown, Stage | AlchemyContext>;

/** The recipe file named on the command line does not exist. */
export class RecipeNotFound extends Data.TaggedError("RecipeNotFound")<{
  path: string;
}> {
  override get message() {
    return `No recipe at "${this.path}". Pass a path, or run from a directory containing alchemy.run.ts.`;
  }
}

/** The recipe path could not be inspected; it is not the same as absence. */
export class RecipePathUnreadable extends Data.TaggedError("RecipePathUnreadable")<{
  path: string;
  cause: PlatformError;
}> {
  override get message() {
    return `Could not inspect recipe path "${this.path}": ${this.cause.message}`;
  }
}

/**
 * The recipe imported, but its default export is not something that can be
 * planned.
 *
 * Worth a distinct error because the mistake is common and the symptom is
 * otherwise baffling: a recipe that forgets `export default` imports perfectly
 * and then fails somewhere deep inside the engine.
 */
export class RecipeNotAStack extends Data.TaggedError("RecipeNotAStack")<{
  path: string;
  found: string;
}> {
  override get message() {
    return `"${this.path}" does not default-export a stack (found ${this.found}). A recipe ends with \`export default Alchemy.Stack(name, options, effect)\`.`;
  }
}

/**
 * The default export is a *reference to* a stack rather than a stack.
 *
 * `Alchemy.Stack()` called with no arguments returns a cross-stack reference
 * builder — `(stackName) => Output.stackRef(stackName)` — which accepts only a
 * name and discards both the options and the effect. So
 * `Alchemy.Stack<{}>()(name, options, effect)` type-checks, runs, and yields a
 * `StackRefExpr` that names a stack it never built.
 *
 * That is worth its own error because of how far the consequence lands from the
 * cause. `evalStack` reads `.services` off the reference, gets a lazy
 * `PropExpr` instead of a `Layer`, `Layer.buildWithMemoMap` calls `.build()` on
 * it and receives `undefined`, and the run loop finally reports
 * `Fiber.runLoop: Not a valid effect: undefined` — four layers away, naming
 * neither the recipe nor the call that caused it. This repo spent its entire
 * history unable to run the engine because of it, chasing that message
 * upstream. See docs/notes/plan-blocker-repro.md.
 */
export class RecipeIsStackReference extends Data.TaggedError("RecipeIsStackReference")<{
  path: string;
  stackName: string;
}> {
  override get message() {
    return `"${this.path}" default-exports a *reference* to the stack "${this.stackName}", not a stack. That is what \`Alchemy.Stack<...>()(name, options, effect)\` produces: calling \`Stack()\` with no arguments returns a cross-stack reference builder that takes only a name and throws away the options and the effect. Write \`export default Alchemy.Stack(name, options, effect)\` — the direct three-argument form.`;
  }
}

/** The recipe threw while being imported, before any planning could start. */
export class RecipeImportFailed extends Data.TaggedError("RecipeImportFailed")<{
  path: string;
  cause: unknown;
}> {
  override get message() {
    return `"${this.path}" failed while loading: ${String(this.cause)}`;
  }
}

/**
 * Imports the recipe module.
 *
 * A `file://` URL rather than a bare path: on Windows an absolute path is
 * interpreted as a package specifier. Bound to a name of its own so the
 * dynamic import has one obvious home.
 */
const importRecipeModule = (absolutePath: string): Promise<{ default?: unknown }> =>
  import(pathToFileURL(absolutePath).href);

/** Recipe filenames looked for when none is given, in order. */
const DEFAULT_NAMES: readonly ["alchemy.run.ts", "machine.run.ts"] = [
  "alchemy.run.ts",
  "machine.run.ts",
];

/**
 * Resolves the recipe path: the one given, or the first default name present
 * in the working directory.
 */
export const resolveRecipePath = (
  explicit: string | undefined,
): Effect.Effect<
  string,
  RecipeNotFound | RecipePathUnreadable,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    if (explicit !== undefined) {
      const absolute = path.resolve(explicit);
      const found = yield* statIfPresent(
        fs,
        absolute,
        (cause) => new RecipePathUnreadable({ path: absolute, cause }),
      );
      if (Option.isNone(found)) return yield* Effect.fail(new RecipeNotFound({ path: absolute }));
      return absolute;
    }

    for (const name of DEFAULT_NAMES) {
      const candidate = path.resolve(name);
      const found = yield* statIfPresent(
        fs,
        candidate,
        (cause) => new RecipePathUnreadable({ path: candidate, cause }),
      );
      if (Option.isSome(found)) return candidate;
    }
    return yield* Effect.fail(new RecipeNotFound({ path: path.resolve(DEFAULT_NAMES[0]) }));
  });

/**
 * Imports a recipe and returns its default export.
 *
 * The import is dynamic and its specifier is a `file://` URL rather than a
 * path, because a bare absolute path is interpreted as a package specifier on
 * Windows.
 *
 * Nothing here validates the export's *type* beyond "is it an object" — a
 * compiled stack is an Effect whose shape only the engine can judge, and
 * duplicating that judgement would mean guessing at Alchemy's internals. What
 * this does catch is the two mistakes that are otherwise mystifying: no default
 * export at all, and a module that throws on import.
 */
/**
 * Whether a value is Alchemy's `StackRefExpr` — identified by the `kind` tag
 * its own `Output.isStackRefExpr` reads, so this stays true to how Alchemy
 * itself distinguishes them rather than inventing a second rule.
 */
const isStackReference = (value: unknown): value is { readonly stack: string } =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  value.kind === "StackRefExpr" &&
  "stack" in value;

export const loadRecipe = (
  absolutePath: string,
): Effect.Effect<Recipe, RecipeImportFailed | RecipeNotAStack | RecipeIsStackReference> =>
  Effect.tryPromise({
    try: () => importRecipeModule(absolutePath),
    catch: (cause) => new RecipeImportFailed({ path: absolutePath, cause }),
  }).pipe(
    // Annotated because the branches below fail with three different error
    // types and inference otherwise settles on whichever it reads first.
    Effect.flatMap((module): Effect.Effect<Recipe, RecipeNotAStack | RecipeIsStackReference> => {
      const exported = module.default;
      if (exported === null || exported === undefined) {
        return Effect.fail(new RecipeNotAStack({ path: absolutePath, found: "no default export" }));
      }
      if (typeof exported !== "object" && typeof exported !== "function") {
        return Effect.fail(new RecipeNotAStack({ path: absolutePath, found: typeof exported }));
      }
      // A `StackRefExpr` reaches here as a perfectly well-formed Effect, so this
      // is checked by its own `kind` tag rather than by shape. Cheap, and it
      // converts the worst error message in this repo's history into one that
      // names the mistake.
      if (isStackReference(exported)) {
        return Effect.fail(
          new RecipeIsStackReference({ path: absolutePath, stackName: exported.stack }),
        );
      }
      // The single unavoidable narrowing in this package, and it is a genuine
      // boundary: a compiled stack is an Effect carrying functions and a
      // service context, so no runtime check — Schema included — can prove a
      // dynamically imported value is one. What *is* checked above is every
      // property that can be: present, and of a shape that could be an Effect.
      // Anything past that is Alchemy's to judge, and it does, loudly.
      // oxlint-disable-next-line effect/noAs -- genuinely unavoidable boundary cast, see comment above.
      return Effect.succeed(exported as Recipe);
    }),
  );
