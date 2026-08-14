# `@machine-run/git` — backlog

`Git.Config` and `Git.Repo`, plus eight compositions built on them
(`gitIdentity`, `gitIgnore`, `gitAttributes`, `gitAlias`, `gitSigning`,
`gitCredentialHelper`, `gitHooksPath`, `gitConfigFile`).

`Git.Config` is the load-bearing resource: with a live `git config --get` diff it
subsumes most of the surface, and the compositions are thin because of it.

## Verification

- [ ] **`libsecret`'s actual Secret-Service store/fetch round trip.**
      Unverified — three distinct container blockers in sequence (missing
      `/etc/machine-id`, `gnome-keyring-daemon` failing to drop capabilities,
      then even `--privileged` leaving the default "login" collection
      unprovisioned). See `backends/Libsecret.ts`'s doc comment.
- [ ] **`Git.Repo` on Windows.** Three of its `apply` tests fail on the Windows
      runner and the cause has not been read yet — see the Windows section in
      [docs/TASKS.md](../../docs/TASKS.md). Until it is diagnosed, `Git.Repo` is
      not honestly cross-platform.
- [ ] **`git maintenance`'s scheduler paths.** The crontab path is
      container-verified; the macOS `launchd` scheduler (would install a real
      background job) and systemd-timer scheduling on Linux are unverified.

## Known constraints worth encoding

- [ ] **`git verify-commit`'s SSH check is a pure key lookup**, never
      cross-checked against the commit's actual author/committer identity —
      the right key under the wrong principal still passes. Worth a test
      that proves this so it isn't rediscovered; see `Signing.ts`'s doc
      comment. `GitAllowedSigner.principals` is legible metadata, not an
      enforced binding.
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

- [ ] **Per-repo config.** Everything here writes global config or a persona
      include. A machine also has per-repo settings worth reconciling, which
      needs `Git.Config` to take an optional repo path rather than always
      `--global`.
- [ ] **`Git.Remote` beyond `origin`.** `Git.Repo` reconciles only `origin`; a
      fork workflow needs `upstream` too. Deliberately out of scope so far, but
      it is the most common next ask.
