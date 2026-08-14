# AGENTS.md

Read [docs/MAP.md](./docs/MAP.md) first — it is the inventory: every package,
resource, backend and seam, marked `✓` verified / `~` written-but-never-run /
`✗` planned-and-absent, plus the callstack a `plan` travels. Do not describe
something as working until you have checked which mark it carries.

Then [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) and
[docs/SYSTEM-DESIGN.md](./docs/SYSTEM-DESIGN.md) for the current shape and the
tradeoffs behind it, and [docs/CONCEPTS.md](./docs/CONCEPTS.md) for what each
Effect and Alchemy primitive is used for. This file is the rules layer on top.

---

## 0. Verify, don't recall

This repo has already been damaged twice by plausible-sounding assertions that
were never checked. A previous session recorded a fix for
`Context.Tag.Service<...>` that **did not work and could not have worked**
(`Context.Tag` doesn't exist in Effect 4), and recorded that resource tests were
"blocked by an alchemy-test version-skew bug" when nothing was blocking them.

So:

- **Before using any Effect or Alchemy API, grep its shipped types.**
  `node_modules/effect/dist/*.d.ts`, `node_modules/alchemy/src/**`. Do not rely
  on memory of Effect 3, blog posts, or this file.
- **Before claiming something works, run it.** `npm run check`, `npm test`.
- **Before claiming something is impossible, try the direct approach.** The
  "untestable resources" claim survived multiple sessions because nobody tried
  calling the provider body.

### Effect 4 is not Effect 3

| Effect 3 | Effect 4 |
|---|---|
| `Context.Tag.Service<typeof X>` | `typeof X.Service` |
| `Effect.catchAll` | `Effect.catch` |

There is no `Context.Tag` namespace in Effect 4. Writing it compiles to
`unknown`, silently erases every downstream type, and produces a cascade of
baffling errors far from the cause.

Prefer Effect primitives over ad-hoc JS for control flow, concurrency and state:
`Effect.catch`/`catchTag`/`orElseSucceed` over try/catch, `Semaphore` over
hand-rolled mutual exclusion, `Clock` over `new Date()`, `Schema` over
`JSON.parse(x) as T`.

---

## 1. Alchemy is a dependency, not a fork

Do not vendor `alchemy` or `alchemy-test`. A vendored copy puts a second set of
its identity-sensitive `Resource`/`Provider` classes in the tree, and a provider
registered against one copy is invisible to a recipe importing the other — the
dual-package hazard that has already cost this repo two debugging sessions.

**Minimal patches are allowed**, in `patches/`, applied by `scripts/apply-patches.sh`
from `postinstall`. A patch is not a fork: a few lines against a pinned version,
kept in the open, with a header saying what it fixes and when to delete it. There
is no auto-sync — a patch either applies to the pinned version or the install
fails naming the file that moved, so a version bump touching patched code cannot
pass silently.

The bar for adding one: the bug must be diagnosed to a line, blocking, and
reported upstream. Patch to unblock, not to diverge. Delete the patch the moment
upstream ships the fix; if a patch is still applying six months from now, that is
a signal to reconsider the dependency, not to keep patching it.

If a resource seems untestable, see rule 6 — its reconciler is directly callable.

Alchemy's own `AGENTS.md` (in the published package) carries the reconciler and
typed-error doctrine. Its AWS/Cloudflare-specific sections — wave/coordinator
orchestration, distilled/Smithy patching, binding contracts — do not apply here.

---

## 2. No bundle resources. Ever.

A resource is one file, one package, one repo, one secret, one setting, one
connection — never a resource owning a list. If a request sounds like "a resource
that manages all of X", the answer is N atomic resources plus, optionally, a
plain loop helper at composition time (`system-packages/src/bulk.ts`).

---

## 3. New pluggable support follows the backend seam

One interface, one small module per implementation, dispatched by a lookup inside
the *existing* generic resource. See `system-packages/src/Backend.ts` +
`backends/*.ts` and `secrets/src/Backend.ts` + `backends/*.ts`.

Never a new Resource type per backend, and never a special case for a specific
backend inside the generic resource's `diff`/`reconcile`.

---

## 4. Resources are `Reconciler`s

Write a resource as a `Reconciler` from `@machine-run/engine` and register it
with `toProvider`. Do not hand-write `diff`/`reconcile` hooks: the adapter
decides drift detection, write serialisation, snapshot-before-overwrite and
plan-vs-apply capability once, and a hand-written provider opts out of all of
them silently.

`observe` must read live state. A resource that reports what it last wrote
cannot detect drift, which is the entire job.

`matches` is not equality — desired state is often partial. Compare only what
the props actually constrain.

A reconciler cannot express `replace`, `stables` or `precreate`. Pass those via
`toProvider`'s `overrides`, or call `Provider.effect` directly if a resource
genuinely needs more — and say why in its doc comment.

---

## 5. Ground integrations in real, verified CLI surfaces

Every backend parses a real tool's real output. If you add one, verify the actual
command and output shape — run it, read its `--help`, or read its source.

**Verify it in a container before declaring it unverifiable.** Docker is
available here (OrbStack; `orb start` if the daemon is down), so any Linux
tool's real behaviour is one `docker run --rm ubuntu:24.04` away — and
`fedora:latest`, `archlinux:latest`, `debian:stable` likewise. "This machine is
a Mac so apt can't be checked" is not a reason; it is a reason to start a
container. Doing so found that Ubuntu 24.04 ships *only* the deb822 sources
format, which the apt backend had been documented as not supporting.

Capture real output and use it verbatim as the test fixture.

**Only when a target genuinely is not reachable** — Windows, say — say so in a
comment and in docs/TASKS.md rather than inventing certainty. An invented flag
that looks plausible is worse than an acknowledged gap, because it will be
believed.

Tests must use **real captured output** as fixtures, never invented sample text.
An invented fixture makes a parser look correct against output no tool emits.

---

## 6. Testing

- Pure logic → plain `it`/`expect`.
- Effect logic needing a filesystem → `it.effect(...)` with
  `@effect/platform-node`'s `NodeServices.layer`.
- CLI backends → a fake `CommandExecutor` returning canned real output
  (`system-packages/test/backends.test.ts`).
- **Resource logic → build the exported `make*Reconciler` and call `observe`,
  `desired`, `matches` and `apply` directly.** They are plain functions against
  a real temp directory. No Alchemy engine, no harness, no fabricated `session`
  or `bindings`.

Every new resource must export its reconciler separately from its provider
registration, for exactly this reason.

**Do not write tautological tests.** Three were deleted from this repo for
asserting that `fs.writeFileString` writes a file while importing none of the
code they claimed to cover. False coverage is worse than none — it hides the gap.

What genuinely isn't ours to test: plan ordering, state persistence, and
adopt/replace routing. That's Alchemy's.

---

## 7. Concurrency is the default

Alchemy applies resources with `concurrency: "unbounded"`. Any reconcile that is
a read-modify-write on a shared resource must go through `FileLock` (or an
equivalent), and any pair whose *order* matters must express it by referencing
the other's output — Alchemy has no user-facing `dependsOn`.

---

## 8. Secrets never touch state

Alchemy persists props *and* attributes, and `localState()` is unencrypted JSON.
Secret values must never be hashed, logged, or folded into attributes. Backends
return `Redacted.Redacted<string>`. Secrets reach commands via `env` as
`Redacted`, never interpolated into a command string.

`Machine.File.content` is a prop and therefore *is* persisted — never put a
credential in it.

Never automate authentication to a secret store.

---

## 9. Never interpolate a value into a command string

`CommandExecutor` takes one `command: string`. With `shell: false` it splits on
whitespace and ignores quotes; with `shell: true` it invokes `/bin/sh`. Use
`Sh.sh(...)` + `shell: true` (POSIX) or `Sh.pwsh(...)` +
`shell: "powershell.exe"` (Windows). Never a template literal.

---

## 10. `delete` is `() => Effect.void`

Every resource leaves real machine state alone on `alchemy destroy`. If you add
one whose delete *should* reverse something, call that out explicitly in the doc
comment and the PR — it's the exception.

---

## 11. Fail loudly on malformed input

Never guess your way through a file whose structure is wrong. Raise a typed
`Data.TaggedError`. Never collapse an error into absence — `Effect.option` over a
`readLink` turned permission errors into "no symlink here" and produced a
misleading second failure.

Classifying CLI error text into typed errors is best-effort — wording is not a
stable API. Keep a generic fallback and don't build control flow on the finer
buckets.

---

## 12. Types come from schemas

Declare resource props and attributes with `Schema.Struct` and derive the type
(`typeof X.Type`). Both cross a boundary: props arrive from a recipe,
attributes are persisted as JSON and read back on a later run. Closed sets are
`Schema.Literals`, so membership exists at runtime.

Recursive shapes are the exception — keep the hand-written interface and
annotate `Schema.suspend` with it. That is Effect's idiom, and Alchemy's
`Input<>` mapping expands a self-referential alias until the compiler gives up.

Do not use Schema for function-valued shapes: services, backend interfaces and
the reconciler contract stay plain TypeScript.

## 13. Layout

```
packages/<name>/
  package.json     # exports ./lib (types+import) + ./src (bun)
  tsconfig.json    # extends ../../tsconfig.base.json, composite, references deps
  src/
    <Resource>.ts  # Props/State schemas + Resource + make<X>Reconciler + <X>Provider
    Backend.ts     # only for packages with pluggable backends
    backends/*.ts  # one file per implementation
    Providers.ts   # providers() => Layer
    index.ts
  test/
```

Composition-only packages (`ssh`) define no resource
and skip `Backend.ts`/`Providers.ts`.

**Split as things grow, rather than letting a file accumulate.** A module that
has started doing two things becomes a directory: `backends/` already does this
for pluggable implementations, and the same applies one level down —
`backends/apt/` with `list.ts`, `sources.ts` and `install.ts` is better than a
300-line `Apt.ts`. Extract anything two modules both reach for into a shared
module at the nearest common ancestor rather than importing sideways between
siblings. Nesting is cheap; a file that has to be skimmed to be understood is
not.

Cross-package deps go in **both** `package.json` dependencies and tsconfig
`references`.

---

## 14. Don't oversell

This is pre-1.0 software that **has never been deployed against a real machine**.
No README copy, doc comment, or commit message may imply otherwise. If something
is untested, unverified, or unresearched, say so plainly. docs/TASKS.md and
docs/V1-PLAN.md are the standard of honesty expected.
