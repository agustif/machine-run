# `@machine-run/ssh` — backlog

`sshHost()` — one `Host` block in `~/.ssh/config`, composed from a
`Machine.ManagedBlock`. This package now also defines two resources of its
own, `Ssh.Key` and `Ssh.KnownHost` — see `src/Key.ts` and `src/KnownHost.ts`
for the design reasoning (Alchemy's `KeyPair` rejection, the trust-on-first-use
argument for `KnownHost`'s pinned `publicKey`, why a key mismatch raises
instead of resolving itself either way).

- [x] **`Ssh.KnownHost`.** Reconciles one `host`/`keyType`/`publicKey` line in
      `known_hosts`. `publicKey` is a required prop, never fetched — see
      `src/KnownHost.ts`'s doc comment. A pinned key that disagrees with an
      existing line raises `KnownHostKeyMismatch` rather than guessing which
      side is stale.
- [x] **`Ssh.Key`.** Generates via `ssh-keygen` — never Alchemy's `KeyPair`
      (it persists the private key in plaintext state, and in the wrong wire
      format besides). Decision and reasoning are in `src/Key.ts`'s doc
      comment. No `unapply`: losing a generated key on `destroy` is
      unrecoverable, so the reconciler doesn't offer to.
- [x] **Tests.** `test/Host.test.ts`, `test/Key.test.ts`, `test/KnownHost.test.ts`
      — 42 tests. Covers `sshHost` rendering (option ordering, `~`
      pass-through/expansion, `0o700` directory mode, and the prepend
      invariant against a real hand-written `Host *` catch-all), both new
      reconcilers against real temp directories, and a real `ssh-keygen` for
      `Ssh.Key` (verified present and working; nothing here is mocked). Pure
      parsers (`parseKnownHosts`, `findKnownHostEntry`, `appendKnownHostLine`,
      `parsePublicKey`, `parseFingerprint`) are tested without any I/O.
- [x] **Verify against real `ssh -G`** — partially. Ran
      `ssh -F <fixture> -G exe.dev` against a fixture with a specific `Host
      exe.dev` block placed *before* a catch-all `Host *`, both setting
      `ForwardAgent` to different values. Confirmed real ssh: resolves
      `forwardagent` to the *specific* block's value (first match for that
      keyword), while `identitiesonly` (unset by the specific block) still
      comes from the catch-all — i.e. first-match-wins is per-*keyword*, not
      per-*block*, exactly as `Host.ts`'s doc comment already claimed. This is
      the fixture the prepend ordering in `test/Host.test.ts` is built to
      preserve. **Not yet re-verified**: the exact block `sshHost()` itself
      renders (multiple hostnames, `extra`, `ProxyCommand`) hasn't separately
      been run through `ssh -G` — only the ordering invariant has, using a
      hand-written fixture of the same shape.
- [ ] **`@machine-run/machine` does not aggregate this package yet.** Now a
      real gap, not a hypothetical one — `Ssh.Key`/`Ssh.KnownHost` exist and
      `packages/machine/test/ExampleCoverage.test.ts` (or its successor —
      main has since grown `AggregateCompleteness.test.ts`, which does the
      same job at the aggregate-layer level rather than the example-recipe
      level) fails as of this change until `examples/complete-machine` calls
      both and `packages/machine/src/Providers.ts` merges
      `Ssh.providers()`. Deliberately left to whoever owns `packages/machine/`
      — out of this package's own scope.
- [ ] **Agent configuration** — `AddKeysToAgent`, `UseKeychain`, and the
      `ssh-agent` startup story per shell. The shell half probably belongs in
      `@machine-run/shell` rather than here.
- [ ] **`HashKnownHosts` support.** `KnownHost.ts`'s parser only recognises a
      literal hostname in `known_hosts`' first field; `HashKnownHosts yes`
      (macOS's historical default) stores `|1|<salt>|<hash>` instead, which
      this resource cannot match against a plain `host` prop. Not fixable by
      reading the file alone — hashing needs the same salt OpenSSH used. See
      `KnownHost.ts`'s doc comment for the full argument. Worth deciding
      whether `Ssh.KnownHost` should refuse to run against a file with
      `HashKnownHosts` enabled (fail loudly) rather than silently appending
      possibly-redundant unhashed lines forever.
- [ ] **`ssh-agent` reading `Ssh.Key`'s private key.** Nothing here loads a
      generated key into a running agent — `Ssh.Key` only ever writes the file.
      Depends on the agent-configuration item above.
- [ ] **Passphrase-protected keys.** `Ssh.Key` always generates with `-N ""`
      (no passphrase) — a machine reconciler has no human present to type one
      interactively. A passphrase-protected key is a real, more-secure option
      this resource cannot offer without either prompting (breaks
      unattended `deploy`) or reading a passphrase from a secret backend
      (overlaps with, and duplicates, what `@machine-run/secrets` already
      does for *material*, not passphrases-that-unlock-material — a genuinely
      different shape, not solved here).
- [ ] **`Ssh.Key`'s `ecdsa` `bits` isn't validated up front.** `-b` for
      `ecdsa` must be `256`, `384` or `521` — an invalid value currently
      surfaces only as `ssh-keygen`'s own `CommandError`, which is honest but
      unfriendly. Could be a `Schema.Literals` instead of `Schema.Number` if
      narrowed to just `ecdsa`'s valid set — not done here since `rsa`'s
      modulus length has no comparably small closed set to validate against,
      and one prop validating conditionally on another felt like it wanted
      its own pass rather than a rushed addition.
