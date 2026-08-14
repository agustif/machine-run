# `@machine-run/shell` — backlog

`Shell.Login` (`chsh`) plus five rc-file compositions (`envVar`, `pathEntry`,
`alias`, `hook`, `ensureLoginShellLoadsRc`), over a `ShellBackend` seam with five
ids.

This is the **best-verified seam in the repo** — all five backends were exercised
in containers, and that verification is what found bash's login-shell behaviour.
It also owns the only `unapply` in the codebase.

## Verification

- [x] **nu's chdir hook actually firing.** Confirmed live: `docker exec -it
      <container> nu` inside a `tmux` session (a real terminal emulator, not
      just a raw pty — nu's reedline blocks on an unanswered ANSI DSR cursor
      query, `\x1b[6n`, from a bare pty, which is what made earlier attempts
      hang rather than a generic "no TTY" problem) got nu to a real `~>`
      prompt; `cd`-ing into a directory matching the hook's `str starts-with`
      prefix twice produced two lines in a marker file written from inside
      the hook closure, and `$env.config.hooks.env_change.PWD | length` read
      back `1` in the same session. See `docs/notes/shell-notes.md`'s nu
      bullet for the exact commands and output.
- [ ] **`pwsh` on real Windows**, not the Linux container it was verified in.
      Profile paths differ (`Documents\PowerShell` versus `.config/powershell`),
      and that path is the whole thing the backend contributes.
- [ ] **`chsh` against a shell not in `/etc/shells`.** `Login` validates against
      `/etc/shells`, which is the right check, but the failure path — what
      `chsh` actually prints and exits with — has not been captured, so the typed
      error is inferred.
- [ ] **`Shell.Login`'s `unapply`.** The only `unapply` in the repo, and it has
      never run under a real `destroy` because no `destroy` has ever run. Its
      test covers the reconciler directly.

## Coverage

- [x] **`Shell.Function`.** Added as `func` in `Profile.ts`, following the
      existing `alias`/`envVar`/`hook` shape exactly — a plain function
      returning a `Dotfiles.ManagedBlock`, not a new `Resource` type. Backend
      seam extended with `ShellBackend.renderFunction(name, body, params?)`,
      one implementation per shell: - zsh/bash share `renderPosixFunction` (`backends/posix.ts`):
      `name() { body }`, positional args via `$1`/`$2`/`$@` — no
      declaration needed. - fish: `function name ... end`, args via `$argv`/`$argv[n]`. - pwsh: `function name { body }`, args via the automatic `$args` array
      — a real function body, distinct from `renderAlias`'s
      forward-via-`@args` trick for aliasing another command. - nu: `def name [params] { body }` — nu's `def` is genuinely different
      from every other backend here: it's statically parameterised, so
      there's no implicit "argv" a body can read. `FunctionProps.params`
      (ignored by every other backend) names the positional parameters nu's
      signature must declare; omitting it declares a zero-argument
      function, and a caller can pass `["...rest"]` for nu's variadic form.

      **Verified live in containers** (not just read from docs): zsh, bash
      and fish via `docker run --rm ubuntu:24.04` (installing zsh/fish with
      `apt-get`); nu via `ghcr.io/nushell/nushell:latest` (0.114.1, matching
      the version already verified elsewhere in this package); pwsh via
      `mcr.microsoft.com/powershell:latest` (7.4.2). Confirmed for each: a
      function defined in exactly this shape, called with two arguments,
      reads them back correctly (`$1`/`$2` and `$@` for zsh/bash; `$argv[1]`/
      `$argv[2]` and full `$argv` for fish; declared `[a, b]` params for nu,
      plus a `[...rest]` variadic case; `$args[0]`/`$args[1]` and
      `$args -join ' '` for pwsh). All containers were run with `--rm` and a
      unique `--name`, and removed themselves on exit — no cleanup left
      outstanding. Not independently re-captured as byte-exact fixtures the
      way `backends.test.ts`'s hook/alias assertions are (those predate this
      change) — the container output confirmed the *mechanism* per shell,
      and `test/backends.test.ts`'s new `renderFunction` cases assert the
      exact rendered syntax against that confirmed mechanism.

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
