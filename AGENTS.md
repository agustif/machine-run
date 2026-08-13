# AGENTS.md

Instructions for an AI coding agent (or a human doing the equivalent) working
in this repo. Read [ARCHITECTURE.md](./ARCHITECTURE.md) and
[DESIGN.md](./DESIGN.md) first — they explain the actual current shape and
the tradeoffs behind it. This file is the rules layer on top.

## Upstream reference — do not re-derive Alchemy's own doctrine

machine-run's resources are ordinary Alchemy resources. The reconciler
doctrine (one observe → ensure → sync → return flow; never branch the whole
reconcile body on `output === undefined`), the typed-error doctrine (every
error a resource can produce in practice is a `Data.TaggedError`, never an
`unknown`/duck-typed catch), the "never raw `async`/`await`/`node:fs` in
resource code — use Effect platform services" rule, and the file-system
convention of co-locating a resource's contract and provider in one file are
all **Alchemy's own doctrine**, documented in full in Alchemy's `AGENTS.md`:

- During dogfooding, the canonical copy is at
  `/Users/a/alchimist/alchemy/AGENTS.md` on the author's machine.
- Once Alchemy is public, the equivalent lives at the root of the `alchemy`
  package/repo (alchemy.run) — look for `AGENTS.md` there.

**Read that file's "Reconciler doctrine" and "Typed Error Doctrine" sections
before writing or modifying any resource in this repo.** Do not copy its AWS-
or Cloudflare-specific factory/orchestration sections (the wave/coordinator
process, distilled/Smithy patching, capability/binding conventions) — none of
that applies here; machine-run has no generated SDK, no cloud provider, and
no Binding Contracts. What *does* apply, and is restated below only to the
extent it needs machine-run-specific adaptation, is the reconciler shape, the
typed-error shape, and the one-resource-per-file convention.

## Hard rules specific to this repo

1. **No bundle resources. Ever.** A resource is one file, one package, one
   repo, one secret file, one macOS default, one connection — never a
   resource that owns a list of things. See DESIGN.md's "god-provider
   correction" section for the exact history this rule comes from. If a
   feature request sounds like "a resource that manages all of X," the
   answer is N atomic resources plus, optionally, a plain loop helper at
   composition time (see `system-packages/src/bulk.ts`'s `packages()` /
   `repos()` for the pattern) — never a new resource type that owns a list.

2. **New pluggable-provider support follows the backends pattern.** Look at
   `system-packages/src/Backend.ts` + `system-packages/src/backends/*.ts`
   before adding support for a new package manager, secret backend, or
   AI-tool integration that has multiple interchangeable
   implementations behind one shared shape: define one small interface, add
   one small implementation module per provider, and dispatch from inside
   the *existing* generic resource's provider via a lookup map. Do not create
   a new Resource type per backend, and do not touch the generic resource's
   `diff`/`reconcile` shape to special-case a specific backend.

3. **`delete` is `() => Effect.void` unless you have a specific, deliberate,
   documented reason not to be.** Every resource in this repo today leaves
   real machine state alone on `alchemy destroy` (installed packages stay
   installed, managed blocks and symlinks stay in place, secret files stay
   on disk, macOS defaults stay set, Tailscale stays connected) — only
   Alchemy's own state bookkeeping is cleared. If you add a resource whose
   delete *should* actually reverse something on the machine, call that out
   explicitly in the resource's doc comment and in your PR — it's the
   exception, not the default.

4. **Secrets never touch Alchemy's local state.** Anything backed by a
   secret (`Machine.SecretFile`'s content, `OnePassword`/`Doppler`'s return
   values) must never be hashed, logged, or otherwise folded into a
   resource's `Attributes`/`diff`/`output`. `Machine.SecretFile` is the
   reference example: it diffs on `fs.exists(news.path)` only. If you add a
   new secret-backed resource or a new secret backend, this constraint is
   non-negotiable — Alchemy's local state is unencrypted JSON meant to be
   committed to a private repo.

5. **Ground new provider integrations in real, fetched docs/APIs — never
   invented interfaces, flags, or output formats.** Every existing backend
   parses a real CLI's real output shape (`dpkg-query -f`'s format string,
   `cargo install --list`'s indentation convention, `npm ls -g --json`'s
   `dependencies` object shape, `port installed`'s table layout). If you add
   a new backend, secret source, or AI-tool config path, verify the actual
   command/API surface (run it, read its docs, or read its source) rather
   than guessing a plausible-looking shape — and add a
   `system-packages/test/backends.test.ts`-style test with a fake
   `CommandExecutor` returning *real* captured output, not invented sample
   output.

6. **Testing approach and its known gap.** This repo uses `@effect/vitest`
   (real, published, stable), not `alchemy-test` (Alchemy's own private,
   unpublished test harness — confirmed broken via a `queueMicrotask`/
   `AsyncLocalStorage` bug even pinned to the exact git tag matching the
   published `alchemy` version in use here). Concretely:
   - Pure logic → plain `it`/`expect` (e.g. `renderFile` in
     `dotfiles/test/ManagedBlock.test.ts`).
   - Effect-based logic needing a real filesystem → `it.effect(...)` piped
     through `@effect/platform-node`'s `NodeContext.layer` (see
     `core/test/backup.test.ts`, `core/test/hash.test.ts`).
   - Package-manager/CLI backend logic → a fake `CommandExecutor` object
     returning canned stdout (see `system-packages/test/backends.test.ts`).
   - **There is currently no way to test a full Alchemy Resource/Provider
     lifecycle (`diff`/`reconcile` through the actual engine) in this repo.**
     Don't pretend otherwise, and don't attempt to route new tests through
     `alchemy-test` or `alchemy/Test/Alchemy` — it is not a working
     dependency here (`package.json` doesn't list it). If you're asked to
     add lifecycle-level tests, say so plainly and either wait on Alchemy's
     own harness stabilizing or propose an alternative — don't silently
     write a test that imports a package that isn't installed.
   - Known bug in the current tree: `dotfiles/test/File.test.ts` and
     `dotfiles/test/Symlink.test.ts` still import from `"alchemy-test"` and
     `"alchemy/Test/Alchemy"` — leftover from before the migration, missed
     when `ManagedBlock.test.ts` was converted. Fixing or rewriting these two
     files (see TASKS.md) is a good first task for anyone touching tests
     here.

7. **File/module layout convention** — match the existing 9 packages:

   ```
   packages/<name>/
     package.json         # @machine-run/<name>, exports ./lib (types+import) + ./src (bun)
     tsconfig.json         # extends ../../tsconfig.base.json, composite, outDir ./lib
     src/
       <Resource>.ts        # Props + Resource<...> + *Provider, co-located
       Backend.ts           # only for packages with pluggable backends (system-packages)
       backends/*.ts        # one file per backend implementation, if applicable
       Providers.ts         # providers() => Layer.mergeAll(...).pipe(Layer.provide(...))
       index.ts             # export * from "./X.ts" barrel
     test/
       <Resource>.test.ts   # or backends.test.ts, per the testing approach above
   ```

   Composition-only packages that define no resource of their own
   (`git-identity`, `ssh`, `ai-tools`) skip `Backend.ts`/`Providers.ts`
   entirely — they only need `index.ts` re-exporting their composition
   function(s) (`gitIdentity`, `sshHost`, `aiTools`), which `yield*` the
   `Dotfiles` primitives directly.

8. **`isResolved(news)` guard in every `diff`.** Every resource's `diff`
   starts with `if (!isResolved(news)) return undefined;` (from
   `alchemy/Diff`) before touching `news` properties — copy this, don't skip
   it, even for a trivial new resource.

9. **This is pre-1.0, dogfooding-stage software.** Don't write doc comments,
   README copy, or commit messages that oversell current completeness. If
   something is untested, unresearched, or commented-out-pending-review, say
   so directly (see BLUEPRINT.md and TASKS.md for the standard of honesty
   expected).
