# Lint policy

`oxlint` with [`oxlint-plugin-effect`](https://github.com/cevr/effect-oxlint)
is the guardrail against non-Effect-native code drifting back in. It runs as
part of `npm run check`.

**All 25 of the plugin's rules are enabled.** Nothing is disabled outside one
narrow test override, because a disabled rule is invisible and an invisible
rule is one that quietly stops being true.

Rules are in two tiers: `error` for what is already clean, and `warn` for known
debt that is counted and tracked rather than hidden. A `warn` is a promise to
migrate, not an exemption.

---

## Enforced (`error`)

These catch genuinely non-Effect-native code. Each has a native replacement
already used in the codebase:

| Rule | Native replacement |
|---|---|
| `noAsyncFunction`, `noNewPromise` | `Effect.gen`, `Effect.promise` |
| `noTryCatch`, `noThrowStatement`, `noNewError` | `Data.TaggedError` + `Effect.fail`, or `Result` for pure code |
| `noGlobals` | `Crypto` for hashing, `Clock`/`DateTime` for time, `Config` for env |
| `noEffectDo`, `noEffectBind`, `preferEffectFn` | `Effect.gen`, `Effect.fn` |
| `noUnsafeDictionaryType` | a `Schema.Record` or a named struct |
| `noChainedTypeAssertions`, `noWidenThenAssert`, `noKnownValueWidening` | parse at the boundary with `Schema` |

Migrations these drove: `sha256` moved from the `crypto` global to Effect's
`Crypto` service; the backup timestamp from `new Date()` to `DateTime`; the
`env` secret backend from `process.env` to `Config.redacted`; the plist codec
from `throw` to `Result`; `bulk.ts`'s hand-rolled FNV-1a to `Hash.string`.

## Tracked debt (`warn`)

Nothing is `off` outside one narrow test override. A `warn` is debt with a
count, not an exemption — the count is the migration backlog, and each is
tracked in [TASKS.md](./TASKS.md).

The primitives these migrate toward, all of which Effect already provides:

| Pattern | Primitive |
|---|---|
| `x !== undefined ? f(x) : fallback` | `UndefinedOr.match` / `UndefinedOr.map` |
| `cond ? a : b` on a boolean | `Boolean.match` |
| dispatch over a closed set | `Match.value` + `Match.when` / `Match.tag` |
| presence where absence has meaning | `Option` |
| a pure computation that can fail | `Result` |

- **`noNullish`** — roughly two thirds are forced by Alchemy: `diff` returns
  `undefined` for no-op, attributes are JSON where absence is an absent key, and
  optional props are `?`. The rest are ours and are migratable — `Reconciler`'s
  `observe` and `Backups.snapshot` both return `T | undefined` by our own choice.
  Where `undefined` genuinely is the contract, `UndefinedOr` operates on it with
  real combinators instead of hand-written comparisons.
- **`noTernary`** — the rule exists because Effect has better control-flow
  primitives, not because ternaries are ugly. Each cluster should become
  `UndefinedOr.match`, `Boolean.match` or `Match`.
- **`noAs`** — mostly `as const` on literal tuples, which is how a literal type
  is obtained. Audit for the genuine assertions.
- **`noRuntimeTypeof`** — the survivors dispatch on JavaScript *shape* before any
  schema could apply, deciding which schema to try.
- **`noConditionalEmptyObjectSpread`** — omitting a key rather than setting it to
  `undefined`, which is load-bearing for `CommandProps.env` and for persisted
  attributes. To be centralised as one helper so the pattern lives in one place.
- **`noUnknownParameters`** — `cause: unknown` on a tagged error is honest;
  narrowing it would be a claim the code cannot support.
- **`noNodeBuiltinImport`** — `os.homedir()` has no Effect equivalent. Isolated
  behind `MachinePaths`.

## Test override

`packages/*/test/**` relaxes `noThrowStatement`, `noNewError` and `noGlobals`.
A test reports failure *by throwing* — that is the runner's mechanism, not a
control-flow choice — and building a fixture with `JSON.stringify` is not an
ambient dependency. Nothing else is relaxed anywhere.

---

## Adding a rule back

Flip to `warn`, run `npx oxlint` for the real count, work it down, then flip to
`error`. Do not add file-level suppressions — a rule that needs suppressing in
many files is a rule this document should be arguing about instead.

## The two override blocks, and why they exist

Nothing is disabled globally. Two narrow overrides carry the exceptions, and
both are cases the rules' own text anticipates — several `noGlobals` messages
end with "platform adapters may disable this rule explicitly".

**`packages/*/test/**`** — `noThrowStatement`, `noNewError`, `noGlobals`,
`noAsyncFunction`. Tests construct failures deliberately, read fixtures off
disk, and drive promise-returning helpers. Applying the rules here would mean
writing tests that cannot express the failure they are pinning.

**`packages/cli/src/{bin,Diagnostics,Recipe}.ts`** — `noGlobals`,
`noAsyncFunction`, `noNewPromise`, `noDynamicImports`. This is the process
boundary: `process.argv`, `process.stdout`, `process.exitCode`, and a dynamic
`import()` of a recipe path known only at runtime.

`Diagnostics.ts` deserves its own note, because the exception there is
load-bearing rather than convenient. `runToExit` races the program against a
plain `setTimeout` **outside** Effect. Using `Effect.sleep` or `Effect.timeout`
would put the timer in the same fiber as the work — and the failure being
guarded against is precisely a defect that kills that fiber without settling its
promise, which leaves the timeout unobserved and the process exiting 0 in
silence. An Effect-native timer cannot catch the thing it needs to catch.
