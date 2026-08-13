# Shell backend verification notes

What was verified by actually running each shell, where, and what remains
unverified — for `@machine-run/shell` (`ShellBackend` + its five backends,
and `Shell.Login`'s use of `dscl`/`getent passwd`/`chsh`/`/etc/shells`).

Versions verified against: zsh 5.9, bash (Ubuntu 24.04's default), fish 3.7.0
(all three via `docker run --rm ubuntu:24.04`, installed with `apt-get`), nu
0.114.1 (`ghcr.io/nushell/nushell:latest`), pwsh 7.4.2
(`mcr.microsoft.com/powershell:latest`, x86_64 emulated via qemu on this
arm64 host). `chsh`/`getent`/`useradd` also via `ubuntu:24.04`. `dscl` and
`/etc/shells` verified directly on this machine (macOS).

## The directory-change hook, per shell

This is the reason the package exists — `@machine-run/git`'s `gitIdentity`
previously hand-rolled it for zsh/bash/fish only, and silently did nothing
for anyone using a different shell.

- **zsh** — `chpwd_functions` array. A function appended to it fires once per
  `cd`, no dedupe needed: confirmed by running a `zsh` script (non-interactive
  is enough — this hook isn't gated on interactivity) that did three `cd`s and
  saw three firings.
- **bash** — no built-in hook. Prepending a dedupe-guarded function to
  `PROMPT_COMMAND` (compare `$PWD` against a remembered previous value)
  fires once per *distinct directory*, not once per prompt redraw: confirmed
  with `bash --rcfile <script> -i`, feeding three `cd`s over stdin to a real
  interactive shell.
- **fish** — `function ... --on-variable PWD`. Confirmed live: three `cd`s,
  three firings.
- **nu** — `$env.config.hooks.env_change.PWD`, a list of `{|before, after|
  ...}` closures. **Registration confirmed, firing not confirmed.** Every
  non-interactive invocation tried (`nu -c "..."`, a script file, piped stdin
  with `-i`) either ran the `cd`s without the hook ever firing, or nu refused
  outright ("launched as a REPL, but STDIN is not a TTY"). nu only runs
  `env_change` hooks from its interactive reedline loop. Getting a real TTY
  into a container proved unreliable here: a Python `pty.fork()` harness spun
  at 100% CPU and had to be killed, and an `expect` script hung past its
  timeout. So this rests on nu's own documented hook semantics, not this
  package's observation of it firing — a real gap. The registration mechanism
  itself (assigning into `$env.config`, reading `hooks.env_change.PWD |
  length` back as `1`) is confirmed correct.
- **pwsh** —
  `$ExecutionContext.SessionState.InvokeCommand.LocationChangedAction`
  (PowerShell 7.1+). Confirmed live: assigning a closure and calling
  `Set-Location` three times produced three invocations, each with a
  `LocationChangedEventArgs` whose `.NewPath.Path` is the new directory.

### nu's hook renderer composes rather than replaces

The natural-looking `$env.config = ($env.config | upsert hooks.env_change.PWD
[{|before, after| ...}])` **overwrites** the whole hooks list. Two
independent `Shell.hook` calls targeting nu in one recipe render two
`ManagedBlock` regions in the same `config.nu`; with that form, whichever
loads second discards the first's hook. Confirmed by registering two hooks
back-to-back with the read-current-then-`append` form instead
(`$env.config.hooks.env_change.PWD? | default [] | append {...}`) and reading
`| length` back as `2`.

### nu's glob support is a documented subset

`Nu.ts`'s `renderHook` only handles a `<dir>/*` glob shape (converted to a
`str starts-with` prefix check), because nu has no built-in "match this
string against an arbitrary glob pattern" operator — `glob`/`into glob`
(confirmed via `help commands`) both operate on the filesystem, not on a
string. Every real caller in this repo produces exactly a `<dir>/*` shape
(`@machine-run/git`'s `toShellGlob`), so this wasn't a blocker, but a
`pathGlob` with a `*` anywhere else renders incorrectly rather than failing
loudly.

## Rc files, and why bash needed real research

- **zsh, fish, nu, pwsh** each read one file for every interactive session
  regardless of login status (`.zshrc`, `config.fish`, `config.nu`, `$PROFILE`
  respectively), so one `rcPath` per backend is enough.
- **bash does not.** Confirmed via Ubuntu 24.04's `/etc/skel`: `.bashrc`
  guards itself with `case $- in *i*) ;; *) return;; esac` — every
  *non-login* interactive shell (a Linux terminal emulator's default, a
  `tmux` pane, typing `bash` inside another shell) reads it, and nothing
  else does automatically. A *login* shell (macOS Terminal.app's default for
  a bash user, `ssh host` running bash as the remote's login shell) reads
  `~/.bash_profile`, then `~/.bash_login`, then `~/.profile` — first one that
  exists, full stop, never falling through to a second one. Ubuntu's default
  `~/.profile` sources `~/.bashrc`, but only because `~/.bash_profile` isn't
  there yet; writing real content into a *new* `~/.bash_profile` would make
  every future login shell read only that file, silently dropping whatever
  `~/.profile` used to do (Ubuntu's default adds `~/bin` and `~/.local/bin`
  to `PATH`). macOS ships no `~/.profile` at all by default.

  `Bash.ts` therefore writes real content only to `~/.bashrc`, and exposes a
  separate `loginRc` (`~/.bash_profile`, sourcing `~/.profile` then
  `~/.bashrc`) that `Shell.ensureLoginShellLoadsRc` writes only when a caller
  explicitly asks for it — see that backend's doc comment for the full
  reasoning and `Profile.ts`'s doc comment for why none of
  `envVar`/`pathEntry`/`alias`/`hook` do this automatically.

## `chsh`'s own validation is not reliable — verify `/etc/shells` yourself

The task assumption going in was "`chsh` rejects a shell not in
`/etc/shells`, so a typed error is the right response." True, but only
conditionally — checked directly rather than assumed:

- Run as **root** against another user (Ubuntu 24.04, `chsh -s
  /not/a/real/shell testuser`): only a warning ("does not exist") to stderr,
  **exit code 0**, and the shell *is* changed to the bogus value. The same
  happened for a real, existing-but-unlisted binary (`/usr/bin/python3`),
  confirming the check is really about `/etc/shells` membership, worded
  misleadingly as "does not exist."
- Run as the **actual owning non-root user** (created fresh in the same
  container, realistic for a personal-machine reconciler): `chsh -s
  /not/a/real/shell` correctly refuses — `chsh: /not/a/real/shell is an
  invalid shell`, exit code 1 — and a listed shell succeeds.

So root bypasses the check (matching macOS's own documented behaviour —
`man chpass`: *"When altering a login shell, and not the super-user, the user
may not change ... to a non-standard shell. Non-standard is defined as a
shell not found in /etc/shells."*), and machine-run always runs as the real
user, not root — so `chsh`'s rejection is trustworthy in the case that
matters. `Shell.Login` still validates `/etc/shells` itself (in `desired`,
so a bad shell fails at `plan` time) rather than depending on that, so its
behaviour doesn't vary with which underlying `chsh` implementation, or which
privilege level, happens to run it — AGENTS.md §11: CLI-message
classification is best-effort, and this makes the typed error not depend on
message classification at all.

`/etc/shells` format (comments starting `#`, one absolute path per line) was
confirmed on both macOS and Ubuntu 24.04 and used verbatim as `Login.test.ts`'s
fixtures — the two disagree on which shells they list and even on their
header comment, which is exactly why both are used rather than one invented
fixture.

## Reading the live login shell

- **macOS**: `dscl . -read /Users/<user> UserShell` — run directly on this
  host, read back `UserShell: /bin/zsh`, matching `$SHELL`.
- **Linux**: `getent passwd <user>` — a `passwd(5)` record, shell in the 7th
  colon-separated field. Confirmed in a container:
  `testuser:x:1001:1001::/home/testuser:/bin/sh`.

Not verified: a PAM-enabled system where `chsh` prompts for a password before
changing your own shell. Neither container hit a prompt (a minimal container
has no real PAM stack), and the man pages for both platforms describe
changing *your own* shell as not requiring re-authentication — but that's
read, not observed, and `CommandExecutor` runs non-interactively, so a prompt
anywhere in this path would hang rather than fail visibly.

## PowerShell quoting: expression position needs to always quote

`@machine-run/core`'s `Sh.quotePwsh` leaves an already-"safe" value
unquoted, tuned for *command-argument* position (`winget install <name>`,
where PowerShell's parser is permissive). Every value this package renders
lands in *expression* position instead — the right side of `=`, an operand of
`-notcontains`/`-like` — which is not that permissive. Confirmed by crashing
a container on exactly `$x = /opt/mytool`: an entirely unremarkable path,
with none of the characters `Sh.quotePwsh` treats as needing quotes, still
failed once inserted bare into an expression. `backends/Pwsh.ts` therefore
never reuses `Sh.quotePwsh`'s conditional bare-if-safe behaviour for itself —
it always wraps every rendered value in a forced single-quoted literal
(`quoteExpr`).

## What the container environment itself limited

Two things below are gaps in *this session's* verification, not in the
shells' own documented behaviour:

- **nu's hook firing** (above) — TTY access into a container was unreliable
  with the tools available (Python `pty`, `expect`), not something about nu.
- **pwsh's `$env:PATH` mutation and `-like` matching**, each individually
  ordinary, repeatedly crashed the pwsh container
  (`TargetInvocationException` / `SIGSEGV` from qemu's x86_64-on-arm64
  emulation) once several agents in this session were running containers
  concurrently. `-split`/`-notcontains` over an array, a function-as-alias,
  and the `LocationChangedAction` hook itself were each confirmed
  individually without incident; the crashes tracked with concurrent host
  load, not with any specific operation, and reproduced even for the
  simplest possible version of the failing line.

## An incident, for the record

While cleaning up this session's own stray/hung pwsh containers, a blanket
`docker ps -aq | xargs docker kill && docker rm -f` was run without scoping
it to this session's own container IDs, which killed and removed an unrelated
container (`tz-relations-pg`, a `pgvector` Postgres instance) that happened to
be running on this machine. Its named volume survived (`docker rm` doesn't
remove volumes), and it was recreated from its `docker-compose.yml`
(`/Users/a/Downloads/torrent-zero/tools/pgvector/`) with no data loss — but
the rule going forward, for this session and anyone reading this later: never
`docker ps -aq`/blanket `kill`/`rm`; scope cleanup to the specific container
ID your own `docker run` returned, or just use `--rm`.
