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
- [ ] **`HashKnownHosts` support.** `KnownHost.ts`'s parser only recognises a
      literal hostname in `known_hosts`' first field; `HashKnownHosts yes`
      (macOS's historical default) stores `|1|<salt>|<hash>` instead, which
      this resource cannot match against a plain `host` prop. Not fixable by
      reading the file alone — hashing needs the same salt OpenSSH used. See
      `KnownHost.ts`'s doc comment. Worth deciding whether `Ssh.KnownHost`
      should refuse to run against a file with `HashKnownHosts` enabled
      (fail loudly) rather than silently appending possibly-redundant
      unhashed lines forever.
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
- [ ] **`Ssh.Key`'s `ecdsa` `bits` isn't validated up front.** `-b` for
      `ecdsa` must be `256`, `384` or `521` — an invalid value currently
      surfaces only as `ssh-keygen`'s own `CommandError`, which is honest but
      unfriendly. Could be a `Schema.Literals` instead of `Schema.Number` if
      narrowed to just `ecdsa`'s valid set — not done here since `rsa`'s
      modulus length has no comparably small closed set to validate against,
      and one prop validating conditionally on another felt like it wanted
      its own pass rather than a rushed addition.
