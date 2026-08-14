# Working notes

Verification logs, one per piece of work: the exact commands run, the real
output captured, and the gaps the author could not close.

These are **evidence**, not documentation. They are append-only and are not
maintained as the code changes — a claim here was true when it was written and
against the machine it was written on. Anything durable graduates into
[../SYSTEM-DESIGN.md](../SYSTEM-DESIGN.md) (why a decision was made),
[../MAP.md](../MAP.md) (what exists and what is verified),
[../ARCHITECTURE.md](../ARCHITECTURE.md) (how it is built) or
[../TASKS.md](../TASKS.md) (what is left).

They are worth keeping because they record what was *actually run*. Several
findings here contradicted assumptions the code had been written on:

- Ubuntu 24.04 ships only deb822 apt sources, so a `sources.list`-only parser
  saw nothing (`system-packages-notes.md`).
- `gsettings set` exits 0 while doing nothing with no session D-Bus
  (`settings-notes.md`).
- bash does not read `.bashrc` in a login shell, so a hook written there never
  fired for Terminal.app or `ssh` (`shell-notes.md`).
- `asdf current` prints its answer and exits non-zero (`runtime-notes.md`).
- 20 of 30 concurrent `git config --global` writers fail on the lock
  (`git-notes.md`).
- `alchemy plan` could not complete for any stack, including an empty one
  (`deploy-notes.md`; since fixed, see `../MAP.md`).
- Node's own `libuv` source admits Windows `chmod`/`stat().mode` "makes
  little sense" — a normal file always reports `0o666`, and `chmod` only
  toggles the read-only attribute (`windows-permissions.md`).
