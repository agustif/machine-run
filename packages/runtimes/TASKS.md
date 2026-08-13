# `@machine-run/runtimes` — backlog

`Runtime.Tool` over a `RuntimeBackend` seam (mise / asdf / rustup / uv). See
[../../docs/runtime-notes.md](../../docs/runtime-notes.md) for exactly what
was verified by running each CLI, and where the remaining gaps are.

## Verification

- [ ] **asdf on macOS or native Linux.** Only verified in an `ubuntu:24.04`
      container so far — the CLI itself and the version-manager plugin
      ecosystem (nodejs used here) should behave the same elsewhere, but that
      is inference, not a check.
- [ ] **`rustup show` with nothing active at all** (no default ever set, no
      override). Every check here ran against a rustup install that already
      had a default toolchain. `parseRustupShow` returns `active: undefined`
      by construction when its regex fails to match, but that shape was never
      actually produced and read.
- [ ] **`XDG_CONFIG_HOME` actually overridden**, for both mise's own config
      resolution (mise uses `MISE_GLOBAL_CONFIG_FILE` specifically, already
      verified) and uv's (`Uv.ts` honors it as an extension of the verified
      default, not an independently-checked override).
- [ ] **mise/uv/rustup on Linux or Windows.** Only checked on this machine
      (macOS). asdf itself has no native Windows support at all.

## Coverage

- [ ] **`nvm`/`pyenv` backends.** The brief asked for one of `uv`/`pyenv`; uv
      was picked. Either follows the identical `RuntimeBackend` seam.
- [ ] **A manifest resource** — `Mise.Toml`, `Asdf.ToolVersions` — modeling a
      whole checked-in manifest file the way `Brew.Bundle` would for Homebrew.
      Deliberately not built in this pass; see `docs/runtime-notes.md`'s
      closing section for the suggested atomic/manifest boundary and
      `docs/V1-PLAN.md` §3 for why the two layers are meant to coexist rather
      than one replacing the other.
- [ ] **Cross-manager tool-name mapping does not exist, on purpose** — same
      as `system-packages`'s `PackageManagerBackend.name`. `tool` is always
      spelled in the manager's own namespace (`"node"` for mise, `"nodejs"`
      for asdf). If that friction turns out to matter in practice, resolve it
      at the composition layer (a lookup table a recipe consults before
      calling `Runtime.Tool`), not by teaching this resource ecosystem names.

## Correctness

- [ ] **Cross-compiled rustup toolchains.** `Rustup.ts` only strips the
      *default* host's triple suffix off a toolchain name; a toolchain
      installed for a different host keeps its full triple-qualified name, so
      a recipe wanting one has to spell it out completely rather than using a
      bare channel/version. Reasoned, not exercised — no cross toolchain was
      actually installed and observed.
- [ ] **No caching.** Two `Runtime.Tool` resources naming the same `(manager,
      tool, scope)` (unusual, not prevented) each shell out independently.
      `system-packages`'s `PackageIndex` is the precedent if this turns out to
      matter; see `docs/runtime-notes.md`'s closing section for why it wasn't
      an obvious win to port over unchanged.
