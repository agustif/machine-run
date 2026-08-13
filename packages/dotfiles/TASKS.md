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
- [ ] **`Machine.Template`** — `File` takes raw content only, so every caller
      that needs interpolation does it by hand.
- [ ] **`Machine.LineInFile`** — narrower than `ManagedBlock` for single-line
      edits, where a whole marked region is heavy-handed.
- [ ] **Reconcile `directoryMode` with `Machine.Directory`.** `File`,
      `ManagedBlock` and `SecretFile` each create parent directories themselves.
      Once a directory resource exists that is a second way to say the same
      thing; pick one.
- [x] **`ManagedBlock` marker escaping.** Closed by refusing rather than
      escaping. Content carrying either of this region's own markers is
      rejected at render time, because these are shell and ssh configs whose
      bytes must survive verbatim — there is no escaping scheme worth having.
      A file that _already_ carries a duplicated marker is also refused, since
      splicing the first pair would silently discard whatever sits between the
      others. Both paths verified to fail without the guards.
