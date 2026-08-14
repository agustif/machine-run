# The `plan` blocker: resolved, and it was ours

This file used to be evidence for an upstream bug report. It is kept because
the diagnosis was wrong in an instructive way, and because the wrong version
was cited from four other documents.

**Status: fixed.** `plan` runs. Against `examples/example-machine`:

```
Plan: 3 to create, 5 to update
[brew-fd] update
[brew-mise] update
[brew-ripgrep] update
[dock-autohide] update
[finder-toolbar] update
[gitconfig-include-personal] create
[gitconfig-personal] create
[shell-path] create
```

## The cause

Every recipe in this repo ended with:

```ts
export default Alchemy.Stack<{}>()(name, options, effect);
```

`Stack` is `taggedFunction(..., (stackName, options, eff) => { if (!stackName) { ... } })`.
Calling `Stack()` with **no arguments** takes that `if (!stackName)` branch,
which returns

```ts
(stackName) => Object.assign(Output.stackRef(stackName).pipe(effectClass), { ... })
```

— a builder for a **cross-stack reference**, accepting only a name and
discarding both `options` and the effect. So `Alchemy.Stack<{}>()(name, options, effect)`
never built a stack. It built a `StackRefExpr` naming one, and threw the recipe
away.

## Why it surfaced four layers later

1. `evalStack` does `const stack = yield* effect` — which yields the
   `StackRefExpr`, whose own keys are `{ stack: "<name>", stage, kind }`.
2. It then does `Effect.provide(stack.services)`. `StackRefExpr` is a lazy
   property-expression proxy, so `.services` returns a `PropExpr` with
   `identifier: "services"` rather than a `Layer`. Nothing validates it.
3. `Layer.buildWithMemoMap` calls `self.build(memoMap, scope)` on that
   `PropExpr`, which returns `undefined`.
4. That `undefined` is handed to `internalEffect.map(...)`, producing a
   `flatMap` primitive whose `args` slot is `undefined`.
5. Evaluating it makes `current` `undefined` inside `FiberImpl.runLoop`, whose
   `catch` block replaces the real `TypeError` with
   `Fiber.runLoop: Not a valid effect: undefined` — discarding the only
   information that pointed anywhere.

Step 5 is why this looked like an Effect defect, and step 2 is why it looked
like an Alchemy one. Neither was.

## How it was actually found

Instrumenting Effect's `dist` at three points, in this order:

1. In `runLoop`, capture `current` **before** `current[evaluate](this)` and log
   it when the result is `undefined`. The `catch` block overwrites `current`, so
   the producer's identity is otherwise lost. This named the producer as a
   `flatMap` primitive whose `successCont` was
   `a => succeed(internalCall(() => f(a)))` — i.e. `Effect.map`.
2. In `map`, log a construction stack when `self === undefined`. This pointed
   at `Layer.js`'s `buildWithMemoMap`.
3. In `buildWithMemoMap`, log `self` when `self.build(...)` returns `undefined`.
   This printed `constructor: PropExpr`, `identifier: "services"` — the whole
   answer.

Each step took one run, because the CLI fails in about a second (see below).

## Causation, proven with one variable

Toggling only the call form on `examples/example-machine/alchemy.run.ts`, same
build, same command:

| form | result |
|---|---|
| `Alchemy.Stack<{}>()(name, options, effect)` | `Fiber.runLoop: Not a valid effect: undefined` |
| `Alchemy.Stack(name, options, effect)` | `Plan: 3 to create, 5 to update` |

## What the curried form was for

A real variance problem, recorded in the comment it replaced:
`ProviderServices` contains `Provider<any>`, and `Provider<T>` declares `of` as
a property-style function, making it invariant in `T` under
`strictFunctionTypes` — so no `Provider<Machine.File>` was assignable to
`Provider<any>`, and the direct overload appeared unusable.

It no longer reproduces: `examples/example-machine` and
`examples/complete-machine` both type-check against the direct form. Whatever
the original obstacle was, the workaround outlived it — and its cost was that
the engine could never run, for the whole life of the repo, because the
workaround type-checked while returning a value of the wrong runtime kind.

## Two earlier claims in this file that were wrong

- **"Nothing this repo wrote is involved."** The minimal reproduction offered as
  proof — zero resources, `Layer.empty`, `inMemoryState()`, no machine-run
  import — used `Alchemy.Stack<{}>()(...)` itself. It reproduced our own misuse,
  not an upstream defect, and its apparent independence is what kept the search
  pointed upstream.
- **"The failure is silent: Node exits 0 having printed nothing", and
  "an `Effect.timeout` that never fired because it lived in the fiber that
  died."** Measured: the CLI printed its full diagnosis and then hung forever
  (exit 124 under an external timeout). `Effect.timeout` observes the defect
  fine — verified three ways. The real second bug was that nothing exited:
  Alchemy's concurrent plan path leaves ~1000 promise resources outstanding
  (confirmed with `async_hooks`) and `bin.ts` never called `process.exit`. Fixed
  by `NodeRuntime.runMain`, which forces exit on a non-zero code. That is what
  makes the CLI fail in ~1s instead of hanging, and it is what made the
  three-step instrumentation above practical.

## Fault 1, and the patch that addressed it

Separately, `Stack.evalStack` wires `Layer.provideMerge(alchemy(dev), platform)`
where `platform` contains `Logger.layer([fileLogger("out")])`, and `fileLogger`
opens with `yield* AlchemyContext` while `AlchemyContextLive` needs the
`FileSystem` and `Path` that `platform` supplies. That produces
`Service not found: alchemy/Context`.

`patches/alchemy+2.0.0-beta.72.patch` addresses it — but **only in
`node_modules/alchemy/src/Stack.ts`**, and alchemy's `exports` map resolves
`./Stack` to `./lib/Stack.js` under the `import` condition. `src` is reached
only under `bun` or `worker`. So under Node the patch changes nothing, which was
verified twice: reverting it leaves `plan` working identically, and applying the
same change to `lib/Stack.js` by hand changed nothing either. The fault-1 stack
trace in the original version of this file cites `alchemy/src/...` paths,
which is the tell — it was captured from a `src`-resolving run.

The patch is therefore correct for `bun`, inert for Node, and was never what
stood between this repo and a working `plan`.
