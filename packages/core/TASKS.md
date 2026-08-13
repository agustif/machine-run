# `@machine-run/core` — backlog

Substrate: the facts about the machine and the process doing the converging.
Nothing here is a resource. See [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

- [ ] **`Platform` service** — os / arch / distro / libc facts, resolved once.
      `detectSystemPackageManager` reads `process.platform` directly today, and
      Windows support needs the same facts in several more places. One service
      keeps the host-fact surface at one call site instead of scattering it.
- [ ] **`optionalKey` helper** — centralise `...(x !== undefined ? { k: x } : {})`,
      which appears a dozen times and exists to _omit_ a key rather than set it
      to `undefined`. One helper makes `noConditionalEmptyObjectSpread`
      satisfiable everywhere else.
- [ ] **`Backups.snapshot` returns `string | undefined`** — that is our contract,
      not Alchemy's, so `Option<string>` says it better.
- [ ] **Backup retention.** Nothing ever prunes `~/.local/state/machine-run/backups/`.
      A machine adopted repeatedly accumulates run directories forever. Needs a
      policy (keep N runs? age out?) and, whatever it is, a way to see what is
      there.
- [ ] **Cross-process locking.** `FileLock` is process-scoped, which is correct
      for concurrent reconciles within one apply but does nothing about two
      `alchemy deploy` runs at once. Alchemy has `Auth/Lock.ts` doing
      file-based locking — read it before inventing anything.
- [ ] Tests for `MachinePaths.expand` (`~`, `~/x`, trailing slashes, a bare
      relative path — which currently resolves against the process CWD, and it
      is not obvious that is right).
