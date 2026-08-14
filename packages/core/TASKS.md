# `@machine-run/core` — backlog

Substrate: the facts about the machine and the process doing the converging.
Nothing here is a resource. See [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

- [x] **`Platform` service** — the supported OS fact is resolved once and
      injected into platform-sensitive reconcilers and package-manager
      detection. Architecture/distro/libc facts are still intentionally absent
      until a backend needs them.
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
- [x] Tests for `MachinePaths.expand` (`~`, `~/x`, a Windows `~\\x` path,
      normalisation, and a bare relative path — which resolves against the
      process CWD by the `Path` service's contract).
- [x] **Windows file permissions are wired through the shared seam.**
      `Machine.File`, `Directory`, `Download`, `SecretFile` and delegated
      `Template` paths observe/apply ACL intent through `Platform` and
      `icacls`; POSIX-only mode fixtures skip explicitly on Windows. The local
      parser/renderer tests pass, while real Windows ACL round-tripping remains
      a CI verification concern rather than a claim made from a Mac.
