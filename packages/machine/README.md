# `@machine-run/machine`

One aggregate `providers()` layer: every resource-defining package's
`providers()`, merged exactly once. Not a resource package itself — it exists
so a recipe can supply a single layer instead of hand-assembling
`Layer.mergeAll(...)`, and so that forgetting one package's providers is a
`tsc -b` failure (a missing entry in this file) rather than a silent
`alchemy plan`/`deploy`-time "service not found."

## What it exports

| Export                         | What it's for                                                                                                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers()` (`Providers.ts`) | `Layer.mergeAll` of every resource package's `providers()`, plus `@machine-run/core`'s `services()` and Alchemy's `CommandExecutorLive()`, provided in the one order that satisfies every sibling's transitive requirements |

Currently merges `ai`, `dotfiles`, `git`, `macos-defaults`, `runtimes`,
`secrets`, `shell`, `ssh`, `system-packages`, `system-services`,
`system-settings`, and `tailscale` — see `src/Providers.ts`. Alchemy's own
`Command.Exec`/`Build`/`Dev` providers are deliberately excluded, since no
package in this repo uses them; a recipe that wants that escape hatch merges
`Command.providers()` in itself alongside this one (see
`examples/example-machine/alchemy.run.ts`).

## Example

From `examples/complete-machine/alchemy.run.ts`:

```ts
import * as Machine from "@machine-run/machine";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack<{}>()(
  "complete-machine",
  {
    providers: Machine.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    // yield* every recipe module here
  }),
);
```

## Verification status

`test/Providers.test.ts` proves the merged layer _resolves_ (every service
each sibling needs is actually satisfied). `test/AggregateCompleteness.test.ts`
proves something stronger and different: it reads `src/Providers.ts`'s source
and fails, naming the package, if any workspace package that defines a
`Resource<T>(...)` is missing from the merge — a layer that resolves cleanly
with nine of ten packages looks identical to one with all ten, so resolving is
not enough to prove completeness. Neither test runs against a real `alchemy
plan`/`deploy` — see [../../docs/MAP.md](../../docs/MAP.md).

## A finding worth flagging

[`../../docs/MAP.md`](../../docs/MAP.md) §1 currently says `system-services` is
"NOT YET AGGREGATED" and directs the reader to `docs/TASKS.md`, and this
package's own [TASKS.md](./TASKS.md) still says `@machine-run/ssh` is
"deliberately absent" from the merge. Neither is true of the code as it stands:
`src/Providers.ts` already merges both `Ssh.providers()` and
`SystemServices.providers()`, and `package.json`'s `dependencies` list both
packages. `test/AggregateCompleteness.test.ts` — which reads source, not
memory — passes with all twelve resource-defining packages present. This
README follows the source; the two docs above are stale and worth fixing
separately.

## What it deliberately does not do

- **Does not decide whether core services are exposed or hidden.** Whether
  `@machine-run/core`'s services should be `provideMerge`d (visible in this
  layer's output type) or `provide`d (hidden) is still open — see
  [TASKS.md](./TASKS.md).
- **Does not include Alchemy's `Command.*` providers.** See above.

See [TASKS.md](./TASKS.md) for the rest.
