# `@machine-run/ssh` — backlog

`sshHost()` — one `Host` block in `~/.ssh/config`, composed from a
`Machine.ManagedBlock`. This package also defines `Ssh.Key` and
`Ssh.KnownHost` — see `src/Key.ts` and `src/KnownHost.ts` for the design
reasoning (Alchemy's `KeyPair` rejection, the trust-on-first-use argument for
`KnownHost`'s pinned `publicKey`, why a key mismatch raises instead of
resolving itself either way).

- [ ] **The exact block `sshHost()` renders hasn't been run through `ssh -G`.**
      Only the first-match-wins *ordering* invariant has been verified against
      real `ssh -G` output (a hand-written fixture) — multiple hostnames,
      `extra`, and `ProxyCommand` in `sshHost()`'s own rendered shape haven't
      separately been checked the same way.
- [ ] **Agent configuration** — `AddKeysToAgent`, `UseKeychain`, and the
      `ssh-agent` startup story per shell. The shell half probably belongs in
      `@machine-run/shell` rather than here.
- [x] **`HashKnownHosts` support.** `KnownHost.ts` recomputes OpenSSH's
      stored-salt HMAC-SHA1 form, matches it without exposing the hashed host
      as a literal state value, and removes the exact hashed line on destroy.
      Malformed hashed entries fail loudly instead of causing a duplicate pin.
- [ ] **`ssh-agent` reading `Ssh.Key`'s private key.** Nothing here loads a
      generated key into a running agent — `Ssh.Key` only ever writes the file.
      Depends on the agent-configuration item above.
- [ ] **Passphrase-protected keys.** `Ssh.Key` always generates with `-N ""`
      (no passphrase) — a machine reconciler has no human present to type one
      interactively. A passphrase-protected key is a real, more-secure option
      this resource cannot offer without either prompting (breaks
      unattended `deploy`) or reading a passphrase from a secret backend
      (overlaps with, and duplicates, what `@machine-run/secrets` already
      does for _material_, not passphrases-that-unlock-material — a genuinely
      different shape, not solved here).
- [x] **`Ssh.Key` validates ECDSA sizes before side effects.** `ecdsa` accepts
      only `256`, `384` or `521`; RSA remains numeric because its valid range
      is tool/version-dependent. Invalid ECDSA input now raises a typed error
      before `ssh-keygen` or filesystem writes run.
