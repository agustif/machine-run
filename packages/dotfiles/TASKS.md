# `@machine-run/dotfiles` — backlog

The file-shaped primitives every other package composes on.

- [ ] **Reconciler tests.** `Symlink` (dangling link, path normalisation, the
      unreadable-path error), `File` (live drift, mode changes), and
      `ManagedBlock`'s reconcile — the pure render/read path is covered, the
      reconciler is not.
- [ ] **Ordering is opt-in and forgetting is silent.** `after` manufactures the
      dependency edge, but nothing requires it, so two `includeIf` regions with
      no `after` get an arbitrary winner and no warning. Decide: refuse a second
      unordered region in one file, or infer from declaration order (which reads
      naturally but disagrees with how the engine actually schedules).
- [x] **`Machine.Template`** — `${name}` substitution over
      `Record<string, string>`, one pass, no recursion, no escape sequence for
      a literal `${...}` (the documented workaround is to name that text as
      its own variable). An unknown placeholder fails render — see
      `Template.ts`'s doc comment for the full argument. Reuses
      `makeFileReconciler` internally rather than re-implementing file I/O:
      `desired`/`apply` render `template`+`variables` into `FileProps.content`
      and delegate everything else, so a changed variable is real drift the
      same way a `Machine.File` hand-edit is (`observe` still reads the live
      file; `desired` re-renders from current props). Tests in
      `test/Template.test.ts` (11 cases: pure `renderTemplate` substitution
      rules, plus reconciler-level apply/drift/render-failure); the
      missing-placeholder guard was verified to actually fail both pure-
      function and reconciler-level tests when temporarily removed, then
      restored.
- [x] **`Machine.LineInFile`** — narrower than `ManagedBlock` for single-line
      edits, where a whole marked region is heavy-handed. Identity is a
      `match` regex (no flags, tested per line) rather than a marker; zero
      matching lines inserts (per `position`), exactly one replaces in place,
      more than one **refuses** in both `observe` and `apply` — there is no
      safe "first match wins" default, the same judgement `ManagedBlock`
      makes for a duplicated marker pair. `line` must itself satisfy `match`
      (checked at `desired` and `apply` time), or a later plan could never
      find its own line again and would insert a fresh duplicate every apply.
      Doc comment states plainly when to use `ManagedBlock` instead
      (multi-line ownership, or content that could plausibly collide with the
      same regex). Tests in `test/LineInFile.test.ts` (17 cases: pure
      `readLine`/`renderLine`, plus reconciler-level insert/replace/drift/
      ambiguity); all three guards (ambiguous-match-on-read,
      ambiguous-match-on-render, line-must-satisfy-its-own-match) were
      verified to fail their corresponding tests when temporarily disabled,
      then restored.
- [ ] **Reconcile `directoryMode` with `Machine.Directory`.** `File`,
      `ManagedBlock` and `SecretFile` each create parent directories themselves.
      Once a directory resource exists that is a second way to say the same
      thing; pick one. `Template` (which delegates straight to `File`'s own
      `directoryMode` handling) and `LineInFile` (which repeats the same
      `makeDirectory` + optional mode pattern) both grew the same
      `directoryMode` prop rather than widen the scope of this task — they
      inherit whatever this item eventually decides.
- [x] **`ManagedBlock` marker escaping.** Closed by refusing rather than
      escaping. Content carrying either of this region's own markers is
      rejected at render time, because these are shell and ssh configs whose
      bytes must survive verbatim — there is no escaping scheme worth having.
      A file that _already_ carries a duplicated marker is also refused, since
      splicing the first pair would silently discard whatever sits between the
      others. Both paths verified to fail without the guards.

- [ ] **Wire `Machine.Template` and `Machine.LineInFile` into `examples/complete-machine`
      and `@machine-run/machine`'s aggregate.** Out of scope for the change that
      added these two resources (`examples/` and `packages/machine/` are the
      orchestrator's territory, not `dotfiles`'s) — `packages/machine/test/
  ExampleCoverage.test.ts` already fails naming exactly these two kinds as
      uncovered, which is the expected, self-documenting signal that this is
      still open, not a bug in either resource.
