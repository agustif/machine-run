import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** The recipe file named on the command line does not exist. */
export class RecipeNotFound extends Data.TaggedError("RecipeNotFound")<{
  path: string;
}> {
  override get message() {
    return `No recipe at "${this.path}". Pass a path, or run from a directory containing alchemy.run.ts.`;
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
    return `"${this.path}" does not default-export a stack (found ${this.found}). A recipe ends with \`export default Alchemy.Stack<{}>()(...)\`.`;
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
  import(`file://${absolutePath}`) as Promise<{ default?: unknown }>;

/** Recipe filenames looked for when none is given, in order. */
const DEFAULT_NAMES = ["alchemy.run.ts", "machine.run.ts"] as const;

/**
 * Resolves the recipe path: the one given, or the first default name present
 * in the working directory.
 */
export const resolveRecipePath = (
  explicit: string | undefined,
): Effect.Effect<string, RecipeNotFound, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    if (explicit !== undefined) {
      const absolute = path.resolve(explicit);
      const found = yield* fs.exists(absolute).pipe(Effect.orElseSucceed(() => false));
      if (!found) return yield* Effect.fail(new RecipeNotFound({ path: absolute }));
      return absolute;
    }

    for (const name of DEFAULT_NAMES) {
      const candidate = path.resolve(name);
      const found = yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
      if (found) return candidate;
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
export const loadRecipe = (
  absolutePath: string,
): Effect.Effect<unknown, RecipeImportFailed | RecipeNotAStack> =>
  Effect.tryPromise({
    try: () => importRecipeModule(absolutePath),
    catch: (cause) => new RecipeImportFailed({ path: absolutePath, cause }),
  }).pipe(
    Effect.flatMap((module) => {
      const exported = module.default;
      if (exported === null || exported === undefined) {
        return Effect.fail(new RecipeNotAStack({ path: absolutePath, found: "no default export" }));
      }
      if (typeof exported !== "object" && typeof exported !== "function") {
        return Effect.fail(new RecipeNotAStack({ path: absolutePath, found: typeof exported }));
      }
      return Effect.succeed(exported);
    }),
  );
