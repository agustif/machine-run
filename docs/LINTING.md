# Lint policy

`oxlint` with [`oxlint-plugin-effect`](https://github.com/cevr/effect-oxlint)
is the guardrail against non-Effect-native code drifting back in. It runs as
part of `npm run check`.

**All 25 of the plugin's rules are enabled, and nothing is disabled in
`.oxlintrc.json`** — no root overrides, no per-package config. A disabled rule
is invisible, and an invisible rule is one that quietly stops being true. A
rule that is wrong is wrong for everyone and should be argued about, not
switched off for the file that finds it inconvenient; a handful of genuine
platform boundaries carry an inline `oxlint-disable-next-line` instead — see
"Inline exceptions" below, which is the complete list.

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
| `noTryCatch`, `noThrowStatement`, `noNewError` | `Data.TaggedError` + `Effect.fail`, `Result.getOrThrow(With)` for pure code that must throw to report a test failure, or `Exit`/`Cause` `.die` for an explicit defect |
| `noGlobals` | `Crypto` for hashing, `Clock`/`DateTime` for time, `Config` for env, `Schema` JSON codecs for `JSON.parse`/`JSON.stringify` |
| `noEffectDo`, `noEffectBind`, `preferEffectFn` | `Effect.gen`, `Effect.fn` |
| `noUnsafeDictionaryType` | a `Schema.Record` or a named struct — `Schema.Json`/`Schema.JsonObject` for a document whose value shape is genuinely arbitrary JSON, never a bare `unknown`/`any` |
| `noChainedTypeAssertions`, `noWidenThenAssert`, `noKnownValueWidening` | parse at the boundary with `Schema` |
| `noAs` | an explicit type annotation (`const x: T = {...}` gives the same literal narrowing `as const` does, without a cast) or a real type guard (`Result.liftPredicate` + `Result.getOrThrow`) instead of asserting |

Migrations these drove: `sha256` moved from the `crypto` global to Effect's
`Crypto` service; the backup timestamp from `new Date()` to `DateTime`; the
`env` secret backend from `process.env` to `Config.redacted`; the plist codec
from `throw` to `Result`; `bulk.ts`'s hand-rolled FNV-1a to `Hash.string`; the
`ai` package's client-config documents from hand-typed `Record<string,
unknown>` plus `JSON.parse`/`JSON.stringify` to `Schema.Record(Schema.String,
Schema.Json)` plus `Schema.fromJsonString` (`packages/ai/src/backends/
jsonConfigFile.ts`); every test-tier `throw new Error(...)` used to unwrap a
`Result` or fail a fake `Exec` to a real `Result.getOrThrow`/`Data.TaggedError`
or a real `alchemy/Command` `CommandError`/`UnexpectedExit` instance.

## Tracked debt (`warn`)

Nothing is `off` anywhere. A `warn` is debt with a count, not an exemption —
the count is the migration backlog, and each is tracked in
[TASKS.md](./TASKS.md).

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
- **`noRuntimeTypeof`** — the survivors dispatch on JavaScript *shape* before any
  schema could apply, deciding which schema to try.
- **`noConditionalEmptyObjectSpread`** — omitting a key rather than setting it to
  `undefined`, which is load-bearing for `CommandProps.env` and for persisted
  attributes. To be centralised as one helper so the pattern lives in one place.
- **`noUnknownParameters`** — `cause: unknown` on a tagged error is honest;
  narrowing it would be a claim the code cannot support.
- **`noNodeBuiltinImport`** — `os.homedir()` has no Effect equivalent. Isolated
  behind `MachinePaths`.

## Adding a rule back

Flip to `warn`, run `npx oxlint` for the real count, work it down, then flip to
`error`. Do not add file-level suppressions — a rule that needs suppressing in
many files is a rule this document should be arguing about instead.

## Inline exceptions

There used to be two override blocks in `.oxlintrc.json` — one relaxing
`noThrowStatement`/`noNewError`/`noGlobals`/`noAsyncFunction` for
`packages/*/test/**`, one relaxing `noGlobals`/`noAsyncFunction`/
`noNewPromise`/`noDynamicImports` for `packages/cli/src/{bin,Diagnostics,
Recipe}.ts`. Both are gone: every test-tier violation had a real fix (mostly
`Result.getOrThrow`/`getOrThrowWith` in place of a bare `throw`, and
`Schema.Json` codecs in place of `JSON.parse`/`JSON.stringify`), and
`packages/cli/src` turned out to need no override at all —
`effect/unstable/cli`'s `Command`/`Stdio` replaced `bin.ts`'s hand-rolled
`process.argv` parsing outright, `Recipe.ts`'s dynamic `import()` already
satisfied `noDynamicImports` once bound to a name with no cast in between, and
`Diagnostics.ts`'s deadline is `Effect.timeout`, not a raced external timer —
see that module's doc comment for what changed the plan (a hypothesis about
`Effect.timeout` being unable to observe the real defect turned out to be
false when tested against the defect directly; the real fix was
`NodeRuntime.runMain` forcing the process to exit on a non-zero code, because
Alchemy's own concurrent plan path leaves the process otherwise unable to
drain on its own after that defect).

What remains is inline, at the exact line, with a reason — visible to the next
reader instead of buried in a glob:

- **`packages/cli/src/Commands.ts`, `withoutEvalStackInternals`** —
  `effect as Effect.Effect<A, E, never>`. Named, bounded to exactly the two
  services `Stack.evalStack` supplies internally, and documented; this is the
  cast AGENTS.md §0b cites as the shape a genuinely unavoidable cast takes.
- **`packages/cli/src/Recipe.ts`, `loadRecipe`** —
  `exported as Recipe`. A dynamically imported module's default export is an
  `Effect` carrying functions and a service context; no runtime check,
  `Schema` included, can prove a value already narrowed to "present, and
  object- or function-shaped" is specifically a compiled stack. Anything past
  that is Alchemy's own judgement to make.
- **`packages/state/src/EncryptedState.ts`, `setEnvelope` and the
  `reviveState` parse** — the two places the encrypted store's type says
  `PersistedState` while the disk deliberately holds an `Envelope`. That
  substitution *is* the feature; `LocalState.set` only serialises whatever it
  is handed. The parse additionally needs `noGlobals`, because a third-party
  reviver is the only thing that can rebuild Alchemy's own
  `Redacted`/`Duration`/`Date` markers and it is typed `any`.
- **`packages/macos-defaults/src/Value.ts`, `PlistValueSchema`** — the
  recursive union asserted to `Schema.Codec<PlistValue>`. Without it the
  compiler gives up with "type instantiation is excessively deep", which the
  constant's own doc comment records. Note the directive sits above
  `Schema.Union([`, not above the closing `]) as ...`: oxlint reports the
  diagnostic at the *start* of the asserted expression, so a
  `disable-next-line` on the closing line silently does nothing.
- **`packages/macos-defaults/src/Value.ts`, `toNative`'s dict arm** —
  `inner as PlistValue`. `isRecord`'s `value is object` is load-bearing in the
  other direction: its *false* branch is what narrows this function's tail to
  `boolean | number | string`. A guard narrowing to `PlistDict` instead would
  leave `PlistArray`/`PlistData`/`PlistDate` in that tail even though the
  branches above handle them — tried, and it fails to compile.
- **`packages/state/test/EncryptedState.test.ts`, the fake `StateService`'s
  `get`** — `rows.get(key(request)) as PersistedState | undefined`. The
  interface promises `PersistedState`, but `wrapState` (the thing under test)
  actually stores an `Envelope` in the same slot once encryption is in the
  loop — a real mismatch between what the interface declares and what this
  fake double holds, not a convenience.
