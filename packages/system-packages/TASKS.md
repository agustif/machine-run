# `@machine-run/system-packages` — backlog

`System.Package` / `System.Repo` over a `PackageManagerBackend` seam.
Backends are split per OS under `src/backends/{macos,linux,windows,language}/`.

## Verification

- [x] **`dnf` and `pacman` against real containers.** Verified against
      `fedora:latest` (dnf5) and `archlinux:latest` — see
      `docs/notes/system-packages-notes.md` and the module doc comments in
      `src/backends/linux/{Dnf,Pacman}.ts`.
- [ ] **`winget` / `choco` against a real Windows target.** Not reachable from
      here — needs a CI runner or a VM. Until then they stay documented as
      unverified and must not be presented as supported.
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
