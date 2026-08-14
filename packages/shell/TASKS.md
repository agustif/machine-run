# `@machine-run/shell` — backlog

`Shell.Login` (`chsh`) plus five rc-file compositions (`envVar`, `pathEntry`,
`alias`, `hook`, `ensureLoginShellLoadsRc`), over a `ShellBackend` seam with five
ids.

This is the **best-verified seam in the repo** — all five backends were exercised
in containers, and that verification is what found bash's login-shell behaviour.
Three resource kinds have an `unapply` today: `Shell.Login`, `Git.Maintenance`
and `System.Setting`.

## Verification

- [ ] **`pwsh` on real Windows**, not the Linux container it was verified in.
      Profile paths differ (`Documents\PowerShell` versus `.config/powershell`),
      and that path is the whole thing the backend contributes.
- [ ] **`chsh` against a shell not in `/etc/shells`.** `Login` validates against
      `/etc/shells`, which is the right check, but the failure path — what
      `chsh` actually prints and exits with — has not been captured, so the typed
      error is inferred.
- [ ] **`Shell.Login`'s `unapply`.** Has never run under a real `destroy` —
      the container check's `destroy` pass covers `Machine.File`,
      `ManagedBlock`, `Directory`, `Symlink`, `SecretFile`, `Exec` and
      `System.Package`, not this. Its test covers the reconciler directly.

## Coverage

- [ ] **Completion registration.** Every one of these shells has a
      completions directory or a registration call, and nothing models it.
- [ ] **Prompt / theme.** Deliberately out of scope so far — starship,
      oh-my-zsh, oh-my-posh are each an ecosystem rather than a setting. Worth an
      explicit decision recorded rather than silence.
- [ ] **`ensureLoginShellLoadsRc` only covers zsh and bash.** fish, nu and pwsh
      have no login/interactive split of the same shape, which is probably
      correct — but the prop type accepts all five `ShellId`s, so it either
      should not, or the other three need a documented no-op.

## Design debt

- [ ] **`rcPath` overrides everywhere.** Every composition takes an optional
      `rcPath` that overrides the backend's default. That is five places where a
      caller can silently write to a file the backend does not consider its own,
      and nothing warns. Consider whether the override belongs on the backend
      selection instead of on each composition.
