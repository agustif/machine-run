# Concept notes

What each Effect and Alchemy concept is used for here, when to reach for it,
and when not to. Written against `effect@4.0.0-rc.108` and
`alchemy@2.0.0-beta.72`, with every API checked against the shipped `.d.ts`
rather than recalled.

[ARCHITECTURE.md](./ARCHITECTURE.md) is the structure; this is the vocabulary.

---

## Alchemy

### `Resource`

`Resource<Type, Props, Attributes>`. **Props** are the recipe's input;
**Attributes** are what gets persisted. Both are written to Alchemy's state
store as JSON, and `Alchemy.localState()` leaves that unencrypted — so neither
may carry a secret's bytes, and both must survive a JSON round-trip exactly. A
`Date` or a `Uint8Array` in either degrades silently into a string or a
numeric-keyed object, which then compares unequal to the value that produced it
and reports drift forever. That is why `macos-defaults` encodes `<data>` and
`<date>` as tagged wrappers.

Adding a resource type is a permanent commitment to a state schema. Prefer
composing existing ones.

### `Provider`

Five hooks: `list`, `read`, `diff`, `reconcile`, `delete`. `Provider.effect(cls,
body)` is just `Layer.effect(Provider(cls.Type), body)`, so a provider body is
an ordinary Effect returning an ordinary object — which is what makes them
directly testable.

Two asymmetries matter and are easy to miss:

- **`diff` and `read` receive no `session`.** Only `reconcile`, `precreate` and
  `delete` do. Since `CommandExecutor.run(props, session)` requires one, a
  resource cannot run a command from `diff` with the obvious API. The engine
  binds a non-reporting session for observation instead.
- **`read` runs only when there is no prior state.** It is the adoption probe,
  not a per-plan drift check. Returning attributes means "this exists and we own
  it"; returning `undefined` means "create it". Drift is `diff`'s job.

`list` is optional and defaults to returning nothing.

### `Diff`

`diff` returns `{ action: "noop" | "update" | "replace" }`, or `undefined`/void
for no change. Always guard with `isResolved(news)` first: during planning,
props can still hold unresolved references to other resources' outputs, and
touching a field before it resolves reads a proxy rather than a value.

### Dependencies and ordering

There is **no user-facing `dependsOn`**. An edge exists when one resource's
props reference another's output. Everything else applies with
`concurrency: "unbounded"`, so independent resources genuinely run in parallel.
`ManagedBlock.after` exists solely to manufacture such an edge.

### `AdoptPolicy`

Routes what `read` reports: `undefined` → create; plain attributes → silent
adopt; `Unowned`-branded → fail, or take over under `--adopt`. Resources with no
ownership semantics return plain attributes and are adopted silently.

### Deliberately not used

Each of these was read in Alchemy's own source and decided on. "We never looked"
is not a decision, so the reasoning is here rather than left implicit.

**`Artifacts`** — a per-resource in-memory bag shared across one
`diff → create/update` run, for expensive deterministic intermediates.
**Rejected at the engine level.** `toProvider` observes twice per resource (once
in `diff`, once inside the lock before `apply`) and caching the first would look
like free savings. It is not: the second observation is what makes the write
race-safe, and a plan-time result reused at apply time would mask drift that
happened in between — a package uninstalled by something else between a human
reading a plan and confirming it would still read as present.
`system-packages` already solved this for itself with two *independent* memoized
listings rather than one shared cache, which is the correct shape. Full
reasoning in `packages/engine/TASKS.md`. `Machine.Download` has no use for it
either: its checksum is a prop, so it never fetches anything just to decide
whether a re-fetch is needed.

**`KeyPair`** — generates and persists a keypair. **Rejected for `Ssh.Key`.**
Its state is `{algorithm, privateKey: Redacted<string>, publicKey}` and its own
doc says the pair is "persisted in state so subsequent deploys keep the same
keys". Combined with the `Redacted` finding below, that puts an SSH private key
in plaintext in `.alchemy/`, outside `~/.ssh` and without ssh's `0600`
expectations — strictly worse than `ssh-keygen`, which never lets the private
half leave the file it was written to. Secondary problem: the formats are PEM
`pkcs8`/`spki`, and PEM `spki` is not the `authorized_keys` format.

**`Action`** — a graph node that runs an Effect when its input changes, with no
provider lifecycle, no `read`, no `delete`. Superficially this is
`Machine.Exec`, and it is worth being clear why it is not: an Action's
idempotence comes from *input equality*, while `Machine.Exec`'s comes from
observing a `unless`/`creates` guard against the real machine. Those differ
exactly when it matters — an Action whose input did not change is skipped even
if the machine drifted underneath it. Still open as the right primitive for
genuinely imperative one-shots that observe nothing, of which this repo has one:
`MacOS.Default`'s `restartApp`.

**`Namespace`** — hierarchical id scoping (`push(id, effect)`). Nothing to scope
yet: a stack manages one machine, so every FQN is already unique. It becomes the
right answer the moment a `machines-<you>` repo manages several machines from
one stack, which is the intended usage and does not exist yet.

**`ProviderMode`** — `live` versus `local` emulation, for `alchemy dev`. It has
nothing to do with plan-versus-apply, which is Alchemy's ordinary lifecycle.
A machine reconciler has no obvious "emulated" mode, because the machine *is*
local. The one plausible reading — resources converging against a throwaway
directory instead of the real `~`, as a sandbox — is speculative, and `plan`
already answers "what would change" without touching anything.

**`RemovalPolicy`** is used, not unused: `toProvider` reads it and defaults to
`retain`, deliberately inverting Alchemy's class-level `destroy` default.

### `Redacted` does not protect state at rest

Worth stating plainly because the name suggests otherwise.
`State/StateEncoding.ts` encodes a `Redacted<T>` as
`{ "__redacted__": <the actual string> }`, with the comment that this is done
"so the actual string is persisted rather than the `<redacted>` placeholder".

`Redacted` prevents a secret from being *printed* — in logs, in errors, in a
console inspect. It does nothing about the state file. Anything that puts a
`Redacted` value in state has put the plaintext on disk.

This repo's answer is not to encrypt around the problem but to avoid it:
`Machine.SecretFile`'s state is `{path, mode}` and contains no secret material
at all, not even a hash. The cost is that secret rotation is undetectable by
construction (see [V1-PLAN.md](./V1-PLAN.md#design-questions-still-open)),
which is a trade made knowingly. See [TASKS.md](./TASKS.md) for the
encrypted state store that would cover what unavoidably lands in state —
Alchemy's `StateService` is an explicit extension point, so it is
implementable without forking anything.

---

## Effect

Effect 4 is not Effect 3. `Context.Tag` does not exist (`typeof X.Service`
replaces it) and `Effect.catchAll` does not exist (`Effect.catch` replaces it).
Both mistakes compile to something plausible before failing far from the cause,
so check the `.d.ts`.

### `Context.Service` + `Layer`

Services carry capabilities that need an environment. Used for `MachinePaths`,
`Backups`, `FileLock` — all three depend on the host and want substituting in
tests.

**Layers memoise by reference within one build.** A factory returning a fresh
`Layer` on each call, provided in two branches, builds twice. That is why
anything holding shared mutable state must not depend on being provided once:
`FileLock`'s table is process-scoped, because the invariant it protects — one
writer per file — is a property of the filesystem, not of a layer.

Not everything needs to be a service. Secret backends are plain values, because
`read` is handed the command runner it should use; making them a service bought
a `CommandExecutor` dependency and nothing else.

### `Schema`

Used at three boundaries, and deliberately nowhere else.

1. **Resource props** — a recipe's input.
2. **Resource attributes** — persisted as JSON, read back on a later run.
3. **Parsed external output** — `npm ls --json`, `tailscale status --json`.
   `Schema.fromJsonString(...)` + `Schema.decodeUnknownEffect(...)` replaces
   `JSON.parse(x) as T`, which asserts a shape nothing verified.

Derive the type, don't write it twice: `export type X = typeof X.Type`.

Closed sets are `Schema.Literals`, so membership exists at runtime rather than
only in the compiler.

**Recursive shapes are the exception.** Keep the hand-written interface and
annotate `Schema.suspend` with it — Effect's own idiom, since the type must
exist before `suspend` can reference it. Here it is doubly required: Alchemy
maps props through `Input<>`, which expands a self-referential *alias* until the
compiler reports "type instantiation is excessively deep". Interfaces defer that
expansion; a derived alias would not.

**Do not use Schema for function-valued shapes.** Services, backend interfaces
and the reconciler contract stay plain TypeScript — Schema cannot represent a
function, and none of them cross a serialization boundary.

### Tagged errors

Two constructors, and the choice is not stylistic:

- **`Data.TaggedError(tag)`** — the default here. A plain tagged class with a
  typed payload, matched by `Effect.catchTag`. Use when the error stays in
  process.
- **`Schema.TaggedError`** — schema-backed, so the error itself can be validated
  and serialized. Use when an error must cross a serialization boundary.
  Nothing here needs that yet.

Rules that hold regardless:

- Give every error a `message` getter that says what to **do**, not just what
  happened.
- Never collapse an error into absence. `Effect.option` over a `readLink` turns
  a permission error into "no symlink here" and produces a misleading second
  failure downstream.
- Absorb a failure at the smallest scope where the answer genuinely doesn't
  depend on why — a distro probe is "not this distro" whether the file is
  missing or unreadable — rather than by widening a declared error channel.
- **Classifying CLI stderr into typed errors is best-effort.** Wording is not a
  stable API and is not predictably localised. Keep a generic fallback and never
  build control flow on the finer buckets; they exist to tell the operator what
  to do next.

Platform failures are read *structurally*, not by message: Effect 4's
`PlatformError` carries `reason: BadArgument | SystemError` with a normalised
`_tag`, so "does this path exist" is `reason._tag === "NotFound"`.

### `Match`

For dispatch over a closed set where every case is a real branch —
`Match.value(platform)` with `Match.when(...)` and a terminating
`Match.orElse`/`Match.exhaustive`. `Match.tag`/`Match.tags` dispatch on `_tag`,
which is the natural fit for tagged unions.

Prefer it over a chain of `if`s when the cases are the point. Do **not** convert
a single early-return guard into a matcher; that adds indirection without adding
exhaustiveness.

### `Result` and `Option`

`Result<A, E>` for a **pure** function that can fail — `renderFile` returns one
rather than throwing, which keeps it total and testable without a runtime.
`Option<A>` for genuine presence/absence where `undefined` would be ambiguous,
as in "this path is not a symlink" versus "this path could not be read".

Neither belongs in persisted state: attributes are JSON, so absence there is an
absent key.

### `Redacted`

The type-level marker that a value must not be printed. Secret backends return
`Redacted.Redacted<string>` so unwrapping is a visible, greppable act, and
secrets reach a command through `env` — where Alchemy's redactor scrubs them
from error messages — never through the command string, which is visible in `ps`
output.

### `Config`

The environment-reading primitive. `Config.redacted(name)` yields an already-
redacted value and honours whatever `ConfigProvider` is in scope, which is why
the `env` secret backend uses it instead of `process.env`.

### `Semaphore`

`Semaphore.makeUnsafe(1)` plus `withPermits(1)` is mutual exclusion.
`makeUnsafe` matters when the semaphore is created lazily per key: an effectful
constructor introduces a suspension between the failed lookup and the insert,
during which a second fiber can install a competing semaphore.

`PartitionedSemaphore` is **not** this. It is a shared permit pool with
round-robin fairness across keys, so capacity 1 serialises everything globally
rather than per key.

### `Cache`

Memoisation with concurrent-lookup de-duplication — two fibers asking for the
same key produce one computation. Used for package-manager listings, where the
alternative is one full `brew list` per declared package.

### `Clock`

`Clock.currentTimeMillis` rather than `new Date()`, so a run's backup timestamp
can be pinned in a test.

### Concurrency

`Effect.all(..., { concurrency: "unbounded" })` matches how Alchemy applies
resources, and is what the `FileLock` regression test uses to reproduce a lost
update before proving the lock prevents it.

---

## machine-run

### `Reconciler`

`address` / `observe` / `desired` / `matches` / `apply`, plus an optional
`snapshotBeforeApply`. `toProvider` turns one into an Alchemy provider.

The point is that the uniform decisions stop being per-resource: drift is always
observation-versus-desire, applies always serialise on `address`, snapshots
always happen at adoption or first write, and plan and apply always get
different capabilities. A resource cannot opt out of any of them by omission.

`matches` is **not** equality. Desired state is frequently partial — a file that
does not pin its mode is satisfied by any mode — so compare only what the props
actually constrain.

`address` is a design decision, not a formality: it determines what contends
with what. Per-file for dotfiles; per-domain for `defaults`, since two keys in
one domain are two read-modify-write cycles over one plist; per-manager for
packages, because `dpkg` holds a global lock and concurrent installs fail.

### `Exec`

`(props: CommandRunProps) => Effect<CommandOutput, CommandError>` — a command
runner with the status session already bound. Handing this to reconcilers and
backends instead of a `CommandExecutor` plus a session is what keeps the
plan/apply asymmetry in one place.

### `Sh`

POSIX and PowerShell quoting. `CommandExecutor` takes one `command: string`:
with `shell: false` Alchemy splits it on whitespace and ignores quotes; with
`shell: true` it goes to `/bin/sh`. So any command carrying a value needs
`shell: true` **and** quoting. Windows needs a separate quoter, not a flag,
because `shell: true` is `cmd.exe` there and `'` is not a quote character at
all.
