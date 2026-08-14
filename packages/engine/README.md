# `@machine-run/engine`

Turns a `Reconciler` — a plain description of how to look at one piece of a
machine, decide what should be true, and converge it — into an ordinary
Alchemy `Provider`. This is where the decisions that would otherwise be made
separately (and inconsistently) in every resource get made exactly once:
drift detection, write serialisation, snapshot-before-overwrite, and
plan-vs-apply capability. It is not a resource package itself; every other
resource package is built on top of it.

## What it exports

| Export                                              | What it's for                                                                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Reconciler<Props, State, E, R>` (`Reconciler.ts`)  | The interface a resource implements: `address`, `observe` (returns `Option.Option<State>`), `desired`, `matches`, `apply`, and optional `list`, `snapshotBeforeApply`, `unapply` |
| `ObserveContext` / `ApplyContext`                   | What a reconciler is allowed to do while looking at vs. changing the machine — `ApplyContext` adds `snapshot`, `ObserveContext` only ever offers a read-only `exec` |
| `toProvider(cls, makeReconciler)` (`toProvider.ts`) | Wraps a `Reconciler` into Alchemy's `Provider` shape (`read`/`diff`/`create`/`update`/`delete`), applying the uniform policy described below                        |

## Example

There's no standalone "engine recipe" to copy — every resource in this repo
_is_ the worked example. The pattern every package follows:

```ts
// inside a resource package's Foo.ts
export const makeFooReconciler = (): Reconciler<FooProps, FooState> => ({
  address: (props) => props.path,
  observe: (props, ctx) => /* read live state, or Option.none() */ ...,
  desired: (props) => /* what these props ask for */ ...,
  matches: (observed, desired) => /* compare only what props constrain */ ...,
  apply: (input, ctx) => /* converge, return new State */ ...,
});

export const Foo = toProvider(FooClass, makeFooReconciler);
```

Exporting `makeFooReconciler` separately from the registered provider is what
lets tests call `observe`/`desired`/`matches`/`apply` directly, with no
Alchemy engine involved — see [../../AGENTS.md](../../AGENTS.md) rule 6.

## What `toProvider` decides, once

See [../../docs/MAP.md](../../docs/MAP.md) §5 for the full callstack a `plan`
travels through this. In short:

- `diff` calls `observe` + `desired` + `matches` with no session, using
  `@machine-run/core`'s `silentSession`.
- `create`/`update` re-observe **inside** a `FileLock` keyed by `address`, so a
  concurrent writer can't race the apply.
- A snapshot is taken via `ApplyContext.snapshot` only when adopting a
  pre-existing resource (or on a resource's first apply) and only when
  `snapshotBeforeApply` is set.
- `delete` defaults to `RemovalPolicy: "retain"` — the opposite of Alchemy's
  own class-level default — and only calls `unapply` under an explicit
  `"destroy"` policy.
- `read` brands its result `Unowned` for a reconciler that sets
  `refuseUnowned`, so Alchemy's `Plan` refuses with `OwnedBySomeoneElse`
  rather than taking over a file this tool has no record of writing. Pass
  `--adopt` to take it over deliberately.

## Renaming a resource

`refuseUnowned` makes one thing sharper than it used to be: renaming a
resource's id is not a no-op. The state row stays under the old id, so the new
id plans a *create*, and a create refuses because what it finds on disk is
unowned.

Alchemy already has the answer — say what it used to be called:

```ts
yield* Dotfiles.File("new-id", { path: "~/.config/thing", content }).pipe(
  renamedFrom("old-id"),
);
```

The engine migrates the row instead of planning a create plus a delete.
`renamedFrom` comes from `alchemy/Rename` and takes a bare id (resolved in the
ambient namespace) or `{ fqn }` for a fully-qualified one.

## More than one machine in one repo

Resource ids are resolved against an ambient namespace, so two machines in one
repo do not need two recipes or hand-prefixed ids:

```ts
yield* Namespace.push("laptop", Effect.gen(function* () {
  yield* Dotfiles.File("gitconfig", { ... });
}));
yield* Namespace.push("desktop", Effect.gen(function* () {
  yield* Dotfiles.File("gitconfig", { ... });
}));
```

Both declare `gitconfig` and neither collides — the state rows are
`laptop/gitconfig` and `desktop/gitconfig`. From `alchemy/Namespace`; nothing in
this package needs to know about it.

## Verification status

Exercised by calling the generated provider's methods directly in tests, and
by a real `plan` → `deploy` → drift → `destroy` cycle in a container
(`scripts/deploy-check.sh`), which drives `toProvider`'s `create`/`update`/
`delete` control flow end to end for seven resource kinds — see
[../../docs/MAP.md](../../docs/MAP.md).

## What it deliberately does not do

- **`delete` never mutates the machine unless a resource opts in.** The
  default `RemovalPolicy` is `"retain"`: removing a resource from a recipe
  must not uninstall software or delete a file nobody asked to remove.
  `unapply` is only called under an explicit `"destroy"` policy, and across
  every resource in this repo exactly one — `Shell.Login` — implements it
  today. See [../../docs/MAP.md](../../docs/MAP.md) §5's closing note on why
  most resources shouldn't: a half-undo that reports success is worse than a
  documented no-op.
- **No engine-level caching of `observe` across `diff` and `reconcile`.**
  Considered and rejected — see [TASKS.md](./TASKS.md)'s "Decided against"
  entry: a generic cache would have to rebuild the same plan/apply staleness
  distinction `system-packages/src/Package.ts` already makes correctly at its
  own level, with none of that package's resource-specific knowledge of what's
  actually expensive to re-observe.

See [TASKS.md](./TASKS.md) for the rest of the backlog.
