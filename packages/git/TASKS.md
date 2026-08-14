# `@machine-run/git` — backlog

`Git.Config` and `Git.Repo`, plus eight compositions built on them
(`gitIdentity`, `gitIgnore`, `gitAttributes`, `gitAlias`, `gitSigning`,
`gitCredentialHelper`, `gitHooksPath`, `gitConfigFile`).

`Git.Config` is the load-bearing resource: with a live `git config --get` diff it
subsumes most of the surface, and the compositions are thin because of it.

## Verification

- [ ] **`Git.Signing` end to end.** Nothing in this repo signs anything, so the
      whole path — `gpg.format=ssh`, `user.signingkey`, `allowed_signers`,
      and an actual `git commit -S` that verifies — is unexercised. This is the
      one composition where being subtly wrong produces commits that look signed
      and do not verify.
- [ ] **The three `CredentialHelperBackend` ids** (`osxkeychain`, `libsecret`,
      `gh`) are unverified. `gh auth git-credential` is the easiest to check in
      CI; `libsecret` needs a session keyring, `osxkeychain` a real login
      keychain.
- [ ] **`Git.Repo` on Windows.** Three of its `apply` tests fail on the Windows
      runner and the cause has not been read yet — see the Windows section in
      [docs/TASKS.md](../../docs/TASKS.md). Until it is diagnosed, `Git.Repo` is
      not honestly cross-platform.

## Known constraints worth encoding

- [ ] **`git config --global` is not concurrency-safe.** 20 of 30 concurrent
      writers fail on the lock (`docs/notes/git-notes.md`). `FileLock` serialises
      writes to the same _path_, and every `Git.Config` addresses the same
      `~/.gitconfig`, so this should already be serialised — but that has never
      been tested under real concurrency. Write the test that proves it.
- [ ] **`includeIf` is last-match-wins**, so persona ordering is load-bearing and
      expressed through `after`, which builds an Alchemy dependency edge by
      referencing another resource's output. That mechanism is subtle enough to
      deserve a test that a mis-ordered pair actually resolves wrongly — proving
      the ordering matters, not just that it works.

## Coverage

- [x] **`Git.Maintenance`** (`git maintenance start`) — the one item from
      V1-PLAN's git table never built. Implemented (`src/Maintenance.ts`),
      container-verified (`docs/notes/git-notes.md`) against real git 2.43.0.
      Two findings that changed the design from the obvious version:
      `git maintenance start`/`stop` are **not** a matched pair — `stop` is
      machine-wide (tears down the shared scheduler for every registered
      repository, not just one), so `unapply` calls `unregister --force`
      instead, which is correctly scoped to this resource's own repository.
      And the task brief's own suggested observation check
      (`maintenance.strategy`) turned out to be a sticky, write-once key that
      `unregister` never clears — `observe` checks membership in the global,
      multi-valued `maintenance.repo` instead, the one signal that actually
      toggles both ways. `address` deliberately shares `Git.Config`'s global
      config file rather than `props.repo`, since `register`/`start` write
      into that same file. UNVERIFIED: the macOS `launchd` scheduler path
      (never run — would mutate a real machine's real `~/.gitconfig` and
      install a real background job) and systemd-timer scheduling on Linux
      (only the crontab path was container-verified).
- [ ] **Per-repo config.** Everything here writes global config or a persona
      include. A machine also has per-repo settings worth reconciling, which
      needs `Git.Config` to take an optional repo path rather than always
      `--global`.
- [ ] **`Git.Remote` beyond `origin`.** `Git.Repo` reconciles only `origin`; a
      fork workflow needs `upstream` too. Deliberately out of scope so far, but
      it is the most common next ask.
