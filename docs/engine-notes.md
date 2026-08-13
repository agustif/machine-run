# Engine notes

Working notes for `@machine-run/engine` and `@machine-run/machine`, kept
separate from the root docs per `AGENTS.md` (root `.md` files are owned by
other agents; this is where `packages/engine`'s own notes belong).

---

## `RemovalPolicy` / `Reconciler.unapply` (V1-PLAN.md §5, §3b)

`toProvider`'s generated `delete` now consults Alchemy's `RemovalPolicy`
itself (`Effect.serviceOption(RemovalPolicy)` from `alchemy/RemovalPolicy`),
defaulting the unset case to `"retain"`. Under `"destroy"` it calls
`Reconciler.unapply` if the reconciler has one; no `unapply`, or any policy
other than `"destroy"`, is a no-op. See the doc comments on `toProvider` and
`Reconciler.unapply` in `packages/engine/src/*.ts` for the full reasoning;
this note records what could and could not be verified.

### Verified, by reading Alchemy's shipped source

- `alchemy/src/Resource.ts`: an unset `RemovalPolicy` context defaults to
  `options?.defaultRemovalPolicy ?? "destroy"` at resource-registration time.
  Nothing in this repo's packages sets `defaultRemovalPolicy`, so every
  machine-run resource's persisted policy is `"destroy"` unless a recipe
  explicitly wraps it in `retain()`. This is the opposite of what
  `docs/V1-PLAN.md` §3b says the invariant should be — which is exactly why
  `toProvider`'s own `delete` re-decides the default itself rather than
  trusting Alchemy's fallback.
- `alchemy/src/Apply.ts` (~line 1969): under a per-resource policy of
  `"retain"`, Alchemy's own apply loop skips calling the provider's `delete`
  entirely — it only clears its own state-file bookkeeping and reports
  "retained". This is a second, independent safety net on top of the one
  `toProvider` now implements, not a duplicate of it.
- `alchemy/src/Apply.ts`'s call site for `provider.delete(...)` (~line 2086):
  does **not** wrap the call in `Effect.provideService(RemovalPolicy, ...)`.
  The only two call sites of `Effect.provideService(RemovalPolicy, ...)` in
  the whole shipped package are inside `RemovalPolicy.ts` itself (the
  `retain()`/`destroy()` combinators a recipe author applies).

### Not verified — and said so in the doc comments

- **Whether `RemovalPolicy` context set by a recipe-level `retain()`/
  `destroy()` actually reaches `toProvider`'s `delete` at runtime.** This
  depends on whether Alchemy's `destroy`/apply orchestration for an existing
  resource runs as a nested continuation of the same top-level Effect the
  recipe's `retain()`/`destroy()` wrapped, or as a structurally separate
  phase with its own context. Reasoned from source, not observed — this
  repo has never run an actual `alchemy destroy` against a deployed stack
  (see `AGENTS.md` §14, "don't oversell").
- The failure mode if it does *not* reach: `Effect.serviceOption(RemovalPolicy)`
  returns `None` always, `toProvider`'s `delete` always reads that as
  `"retain"`, and `delete` is unconditionally a no-op — i.e., identical to
  the behaviour before this change. This is why the mechanism was safe to
  ship un-observed: it can only add an opt-in destructive path on top of the
  existing safe default, never remove it.
- **Whether `retain()`/`destroy()` are meant to wrap one resource's
  registration or a whole recipe.** The type signature (`<R, Req>(a:
  Effect<R, never, Req>) => Effect<R, never, Req>`) is generic over both —
  nothing in Alchemy's shipped source (no docs, no tests bundled in the
  npm package) shows the intended granularity.

### Why no resource restores from a real backup yet

`Backups`' directory is stamped fresh every run (`Clock`-derived, per
`packages/core/src/Backups.ts`), so a `destroy` invocation's own `Backups`
service has no way to find a backup taken during some earlier `deploy` — that
information only survives between runs if a resource's own `State` carries
it, round-tripped through Alchemy's state file. `ApplyContext.snapshot` now
returns the backup path (previously discarded) specifically so a future
resource *could* capture it into its `State` and read it back via
`unapply`'s `recorded` parameter — but no resource in this repo does that
yet. That is a per-resource change, owned by whoever writes that resource,
not something `toProvider` can fabricate on their behalf. Proven only
against a small `Test.Engine.File` reconciler defined in
`packages/engine/test/unapply.test.ts`, per the brief for this work (not
against a real package's resource — those are other agents' files).

---

## `@machine-run/machine`

Aggregates every `@machine-run/*` resource package's `providers()` plus
`@machine-run/core`'s `services()` and a shared `CommandExecutor`, so a
recipe can depend on one layer instead of hand-assembling one (see
`packages/machine/src/Providers.ts` for the full reasoning and
`packages/machine/test/Providers.test.ts` for a compile-time regression test:
it only type-checks if every requirement any merged package leaves unmet is
actually satisfied).

- `packages/shell` did not have a `package.json` or any exports yet when this
  was written (still being scaffolded concurrently). `Providers.ts` has an
  explicit TODO naming exactly what to add once it lands:
  `Shell.providers()` to the `Layer.mergeAll(...)`, `"@machine-run/shell":
  "*"` to `package.json`, `{ "path": "../shell" }` to `tsconfig.json`.
- Root `tsconfig.json` and `tsconfig.tests.json` need a
  `{ "path": "packages/machine" }` reference each — not added by this work,
  since those are shared root files serialized through the session's
  coordinator. `tsc -b tsconfig.tests.json` reports `TS6307` on
  `packages/machine/src/index.ts` and its test file until that reference is
  added, even though the glob in `tsconfig.tests.json`'s `include` already
  matches `packages/machine/test/**`.
- `examples/example-machine/alchemy.run.ts` was deliberately left untouched —
  out of scope for this work; switching it to `Machine.providers()` is a
  follow-up.
