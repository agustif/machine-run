# `Alchemy.Stack()` with no arguments returns a reference, not a stack

Kept because the trap is invisible at the call site and type-checks.

```ts
Alchemy.Stack<{}>()(name, options, effect)   // ✗ builds nothing
Alchemy.Stack(name, options, effect)         // ✓
```

`Stack()` with no arguments takes its `if (!stackName)` branch and returns
`(stackName) => Output.stackRef(stackName)` — a cross-stack *reference* builder
that accepts only a name and discards the options and the effect.

## Why the error names nothing useful

1. `evalStack` does `const stack = yield* effect`, getting a `StackRefExpr`.
2. `Effect.provide(stack.services)` reads `.services` off a lazy property proxy,
   getting a `PropExpr` instead of a `Layer`. Nothing validates it.
3. `Layer.buildWithMemoMap` calls `.build()` on it → `undefined`.
4. `internalEffect.map(undefined, …)` builds a `flatMap` with an `undefined` args
   slot.
5. `FiberImpl.runLoop`'s `catch` replaces the real `TypeError` with
   `Fiber.runLoop: Not a valid effect: undefined`.

Four layers, and the final message names neither the recipe nor the call.

## Guard

`loadRecipe` rejects a `StackRefExpr` default export with a typed
`RecipeIsStackReference`, tested in `packages/cli/test/Recipe.test.ts`.

## Finding it again, if something similar happens

Instrument `node_modules/effect/dist`:

1. `runLoop` — capture `current` *before* `current[evaluate](this)` and log it
   when the result is `undefined`. The `catch` overwrites `current`, so the
   producer is otherwise unrecoverable.
2. `map` — log a construction stack when `self === undefined`.
3. Whatever step 2 points at — log its input.

## The alchemy patch is inert under Node

`patches/alchemy+2.0.0-beta.72.patch` edits `node_modules/alchemy/src/Stack.ts`,
but alchemy's `exports` resolves `./Stack` to `./lib/Stack.js` under the `import`
condition; `src` is reached only under `bun`/`worker`. Reverting it leaves `plan`
working, and applying the same change to `lib` by hand changes nothing. It is
correct for `bun` and does nothing for Node.
