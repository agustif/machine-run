# The `plan` blocker: minimal reproduction

Evidence for an upstream report. Everything here was run, not inferred.

## What fails

`alchemy plan` cannot complete. Two distinct faults sit behind it; the first is
fixed by a patch in this repo, the second is not.

## Fault 1 — layer ordering (patched here)

`Stack.evalStack` wires `Layer.provideMerge(alchemy(dev), platform)`, providing
`platform` **to** the layer that produces `AlchemyContext`. But `platform`
contains `Logger.layer([fileLogger("out")])`, and `fileLogger` opens with
`yield* AlchemyContext` to find the `.alchemy` directory, while
`AlchemyContextLive` needs the `FileSystem` and `Path` that `platform` supplies.

```
Error: Service not found: alchemy/Context
    at alchemy/src/Stack.ts:307
    at alchemy/src/Util/FileLogger.ts:7
```

`patches/alchemy+2.0.0-beta.72.patch` gives the logger layer its own context,
built from the platform services it actually needs.

## Fault 2 — an `undefined` reaches the run loop (open)

Past that, planning dies with:

```
Fiber.runLoop: Not a valid effect: undefined
```

### Minimal reproduction

**Zero resources, `Layer.empty` providers, in-memory state, and no machine-run
import of any kind:**

```ts
import * as Alchemy from "alchemy";
import { inMemoryState } from "alchemy/State/InMemoryState";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack<{}>()(
  "empty",
  { providers: Layer.empty, state: inMemoryState() },
  Effect.gen(function* () {
    yield* Effect.void;
  }),
);
```

Planning this fails identically. **Nothing this repo wrote is involved.**

### What has been ruled out, with evidence

| Hypothesis | How it was excluded |
|---|---|
| The state store | Reproduces with `inMemoryState()`, not only `localState()` |
| Our resources or providers | Reproduces with zero resources and `Layer.empty` |
| A missing provider | `findProviderByType` dies with a clear message instead |
| `providerForMode`'s unchecked `modes` index | Our providers carry no `modes`, so that branch never runs |
| `Logger.layer` receiving an `Effect` | Its signature explicitly accepts one |
| `effectify`'s resume passing `undefined` | Instrumented both branches; `succeed(result)` is never `undefined` |
| `FiberImpl.evaluate` receiving `undefined` | Instrumented; never called with it |

### Where it comes from

With Effect's `dist` build instrumented at the throw site:

```
Error: origin
    at FiberImpl.runLoop      effect/src/internal/effect.ts:676
    at FiberImpl.evaluate     effect/src/internal/effect.ts:610
    at                        effect/src/internal/effect.ts:1117   (callback)
    at                        effect/src/Effect.ts:24831           (effectify resume)
    at FSReqCallback.oncomplete  node:fs
```

`evaluate` receives a valid effect and `current` becomes `undefined` *during*
the loop — so a **continuation returns `undefined`** rather than an Effect,
immediately after a filesystem read resumes. In practice that is a `yield*` on
an undefined value, or a `flatMap` whose function returns nothing, somewhere in
the plan path that runs after an fs read.

### The second bug, which is arguably worse

The failure is silent. A defect thrown inside the run loop can leave the driving
promise unsettled: the event loop drains and **Node exits 0 having printed
nothing**. Verified on the reproduction above — no output, no uncaught
exception, no unhandled rejection, exit code 0, and an `Effect.timeout` that
never fired because it lived in the fiber that died.

That is why `alchemy plan` presents as "exits 1, prints nothing, even at
`--log-level all`", and why this took instrumenting Effect's internals to see at
all.

`@machine-run/cli` refuses to reproduce that: every path prints, failure is
always non-zero, and a program that never settles is raced against a plain timer
**outside** Effect — an Effect-native timer cannot catch a defect that kills the
fiber it lives in.
