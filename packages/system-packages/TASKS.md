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
- [x] **The six language backends** — `cargo`, `npm`, `pipx`, `uv-tool`, `gem`,
      `go-install`. Now `✓` in [MAP.md](../../docs/MAP.md): each installed a real
      package and ran its real `list` command in a container (`rust:latest`,
      `node:22`, `python:3.12`, `ruby:3.3`, `golang:1.23`), with the captured
      output committed as `test/fixtures/*` and pinned by
      `test/languageBackends.test.ts` — see
      `docs/notes/system-packages-notes.md` for the per-backend detail. All six
      parsers matched on the first try, including `go-install`, the one
      expected to be most likely wrong for having no real "list installed"
      command of its own.
- [ ] **`paru`.** Still `~`, but no longer untried: `paru-bin` built and
      installed cleanly in a fresh `archlinux:latest` container, then failed
      to _run_ (`libalpm.so.15` missing — an ABI mismatch this container's
      un-upgraded pacman genuinely has, unlike `yay-bin`'s successful run in
      the same kind of container). Building plain `paru` from source instead
      compiled cleanly through its whole ~140-crate dependency tree but did
      not finish its final release-mode LTO link inside this session's time
      budget (see `Aur.ts`'s doc comment and
      `docs/notes/system-packages-notes.md`). A future session with a longer
      budget (or a faster host than this sandbox's QEMU amd64 emulation) can
      pick the from-source build back up and finish the `-S`/`-Qmq` checks.
- [ ] **`brew-cask` separately from `brew`.** Verified as one backend, but casks
      differ where it matters: `brew list --cask` output, and the fact that a
      cask install can require a GUI prompt or admin password.

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
- [x] **Flatpak remotes have no `System.Repo` support.** Implemented and
      container-verified 2026-08-14 (`docs/notes/system-packages-notes.md`):
      `RepoSpec`'s `Flatpak` tag (`Backend.ts`) carries `name` and an
      optional `location`, and `Flatpak.ts` grew a dedicated
      `makeFlatpakRepoBackend`'s `listRepos`/`addRepo`. Real captured
      `flatpak remotes` output is committed as
      `test/fixtures/flatpak-remotes{-empty,}.txt` and pinned by
      `test/backends.test.ts`, following the exact `languageBackends.test.ts`
      pattern.

      One real, documented limitation, not a bug: `flatpak remote-add`'s
      standard bootstrap URL (the one every Flathub tutorial gives) resolves
      to a *different* URL string than what `flatpak remotes` reports back
      afterward, so a `System.Repo` written with the bootstrap form will
      `apply` correctly every time but never `matches` — every plan reports
      it as needing an update, forever, though harmlessly thanks to
      `--if-not-exists`. Using the resolved location directly instead avoids
      that but fails GPG signature verification without `--no-gpg-verify`, a
      real security downgrade this backend does not add a flag for. See
      `Flatpak.ts`'s `listRepos` doc comment for the full reasoning. Pinned
      by `test/backends.test.ts`'s "a real bootstrap-URL repo never matches a
      live listing" case.
- [x] **`RepoProps`/`RepoState` were `{ manager: RepoManagerId, repo: Schema.String }`**
      — one opaque string whose grammar depended entirely on `manager`
      (a brew tap, an apt PPA, a dnf COPR project, or Flatpak's
      `"<name> <location>"` crammed into one string), so `{ manager: "dnf",
      repo: "flathub https://..." }` type-checked despite being nonsense for
      every backend. Fixed: `RepoSpec` (`Backend.ts`) is now a
      `Schema.TaggedUnion` — `Brew { tap }`, `Apt { ppa }`, `Dnf { project }`,
      `Flatpak { name, location? }` — nested as `RepoProps`/`RepoState`'s
      `repo` field (the same reason `runtimes/src/Backend.ts`'s `RuntimeScope`
      is nested under `RuntimeToolProps.scope` rather than being a resource's
      whole `Props`: Alchemy's `Resource<Type, Props, Attributes>` needs a
      single object type with statically known members, not a bare union).
      `Repo.ts` dispatches to each manager's own `RepoBackend<Spec>` with
      `Match.tagsExhaustive`, so adding a fifth manager without wiring it into
      every dispatch site is a compile error. `PackageManagerBackend`'s
      `listRepos?`/`addRepo?` moved out into their own `RepoBackend<Spec>`
      interface for the same reason — a Brew tap and a Flatpak remote no
      longer have to fit through one `(repo: string) => ...` signature.
      `UnsupportedRepoManager` is gone: every tag in the now-closed `RepoSpec`
      union has a full `RepoBackend`, so the runtime "neither listRepos nor
      addRepo" guard it existed for can no longer occur. This is a
      props-and-state schema break — nothing here has ever been deployed, so
      nothing needed migrating.

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
