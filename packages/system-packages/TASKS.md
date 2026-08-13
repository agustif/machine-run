# `@machine-run/system-packages` — backlog

`System.Package` / `System.Repo` over a `PackageManagerBackend` seam.
Backends are split per OS under `src/backends/{macos,linux,windows,language}/`.

## Verification

- [x] **`dnf` and `pacman` against real containers.** Verified against
      `fedora:latest` (dnf5) and `archlinux:latest` — see
      `docs/notes/system-packages-notes.md` and the module doc comments in
      `src/backends/linux/{Dnf,Pacman}.ts`.
- [x] **`winget` / `choco` against a real Windows target.** Done via CI's
      `verify winget / choco parsers` job. Real output is committed as
      `test/fixtures/{winget,choco}-list.txt` and pinned by
      `test/windowsBackends.test.ts`; `test/windowsLive.test.ts` re-asserts the
      same parsers against freshly captured output on every run, which is the
      direction a frozen fixture cannot cover.

      It found a real bug: winget truncates an over-long cell with an ellipsis
      that consumes the column padding, so the old "split on 2+ spaces" parser
      merged `Id` and `Version` on 9 of 64 rows and produced nothing for 6 more.
      It now slices by header column offsets. Chocolatey 2.7.3 confirmed
      `--local-only` is accepted and `--limit-output` has no header or footer.

- [ ] **`winget export` rather than `winget list`.** A truncated id is not
      recoverable from the table, so those packages read as not installed and
      get a no-op `winget install` every deploy. `winget export` emits JSON with
      full identifiers, but writes to a file rather than stdout — needs a temp
      path through the `exec` seam.
- [ ] **`winget install` flags.** Still unverified: nothing here has installed a
      Windows package. Only the `list` path has been exercised.
- [ ] **MacPorts against a real `port`.** Not installed here; verify the
      `port installed` header and column shape.

## Coverage

- [x] `System.Repo` for dnf (COPR) — `RepoManagerId` now includes `"dnf"`.
      pacman stays out, documented as an intentional decision (AUR has no
      server-side repo concept), not a gap — see `Repo.ts`'s doc comment and
      `docs/notes/system-packages-notes.md`.
- [x] More backends: `pipx`, `uv tool`, `gem`, `go install`, `mas`, `flatpak`,
      AUR helpers (`yay`/`paru`) — all added and verified (see
      `docs/notes/system-packages-notes.md`). `snap` was added too but stays
      UNVERIFIED (snapd needs `systemd`, unreachable from a plain container
      here). `nix` remains unaddressed.
- [ ] **Version pinning.** `PackageProps` has no `version`, so "install ripgrep"
      cannot mean a particular ripgrep. This is a real gap for reproducibility
      and changes `matches` from membership to comparison.
- [ ] **Flatpak remotes have no `System.Repo` support.** `flatpak install`
      only resolves an app ID against an already-configured remote (commonly
      Flathub); adding/removing a remote isn't wired up as a resource. Unlike
      pacman/AUR, this is a real gap, not a decision — see
      `backends/linux/Flatpak.ts`'s doc comment.

## Correctness

- [x] **Tap-qualified brew names.** Fixed: `list` now uses `brew list
--formula --full-name`, verified against a real third-party-tap
      install.
- [x] **`npm ls -g` exits non-zero** when the global tree has unmet peer
      dependencies. Fixed: the list command forces exit 0
      (`shell: true` + `; true`) so a real `ELSPROBLEMS` listing's stdout is
      never discarded by `alchemy`'s `CommandError` (which doesn't carry
      `stdout`).
- [ ] **Implement `list`** so an existing machine can be inventoried into a
      starting recipe rather than hand-written. Currently the engine's default
      empty implementation.
