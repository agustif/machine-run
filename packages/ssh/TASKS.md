# `@machine-run/ssh` — backlog

`sshHost()` — one `Host` block in `~/.ssh/config`, composed from a
`Machine.ManagedBlock`. This package defines **no resource of its own**, which is
the root of most of what follows.

- [ ] **`Ssh.KnownHost`.** Reconcile one entry in `~/.ssh/known_hosts`. The
      interesting part is that the honest source of a host key is
      `ssh-keyscan`, and trusting whatever it returns is exactly the
      trust-on-first-use problem — so this needs a pinned fingerprint prop, not
      a fetch-and-accept.
- [ ] **`Ssh.Key`.** Either generate via Alchemy's `KeyPair` primitive (unused
      by this repo so far) or materialise from a vault through
      `Machine.SecretFile`. These are different resources with different
      guarantees: a generated key exists only on this machine and cannot be
      re-derived, so `destroy` losing it is unrecoverable in a way a vault-backed
      key is not. Decide which one `Ssh.Key` means before naming it.
- [ ] **Agent configuration** — `AddKeysToAgent`, `UseKeychain`, and the
      `ssh-agent` startup story per shell. The shell half probably belongs in
      `@machine-run/shell` rather than here.
- [ ] **`@machine-run/machine` does not aggregate this package.** Correct today,
      because there is no `providers()` to merge — but the moment `Ssh.Key` or
      `Ssh.KnownHost` lands, this package gains providers and the aggregate
      becomes silently incomplete. The aggregate's whole value is completeness,
      and its failure mode is a runtime "service not found" rather than a
      compile error. Land the two together, and see
      `packages/machine/TASKS.md`'s completeness test.
- [ ] **No tests.** This is the only package with a `src/` and no `test/`.
      `sshHost` renders a config block and the rendering is worth pinning —
      option ordering, `~` expansion, the `0o700` directory mode, and the
      `prepend` position (ssh resolves the _first_ matching `Host`, so appending
      a managed block after a hand-written one silently does nothing).
- [ ] **Verify against real `ssh -G`.** `ssh -G <host>` prints the fully
      resolved configuration, which is the only honest way to confirm a rendered
      block means what it looks like. Nothing here has been checked that way.
