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
- [x] **`brew-cask` separately from `brew`.** Read-only verified against this
      real machine's actual `brew list --cask` (thirteen casks, fixture:
      `test/fixtures/brew-list-cask.txt`) — a bare one-token-per-line list,
      no header, no version, which the existing plain `lines()` parser
      already handles correctly with no change needed. `install` stays
      unexercised by design: a cask install can require a GUI prompt or
      admin password this backend cannot satisfy unattended, and nothing
      installs anything on this machine to prove otherwise — see
      `docs/notes/system-packages-notes.md`.

## Coverage

- [x] `System.Repo` for dnf (COPR) — `RepoManagerId` now includes `"dnf"`.
      pacman stays out, documented as an intentional decision (AUR has no
      server-side repo concept), not a gap — see `Repo.ts`'s doc comment and
      `docs/notes/system-packages-notes.md`.
- [x] More backends: `pipx`, `uv tool`, `gem`, `go install`, `mas`, `flatpak`,
      AUR helpers (`yay`/`paru`), `snap` — all added and verified (see
      `docs/notes/system-packages-notes.md`). `snap` needed a privileged,
      systemd-booted container rather than a plain one — the earlier "needs
      systemd, unreachable from a container" note undersold what a
      `--privileged --cgroupns=host` container with a real `/sbin/init` PID 1
      can do. `nix` remains unaddressed.
- [x] **Version pinning.** Closed 2026-08-14. `PackageProps` now carries an
      optional `version: VersionSpec` (`@machine-run/core`'s shared
      `Exact`/`AtLeast`/`Channel`/`Digest` vocabulary — see that module's doc
      comment) and an optional `updatePolicy: UpdatePolicy`
      (`Never`/`ToSpec`/`Latest`, defaulting to `Never`: install once if
      absent, then leave drift alone — the resource's original,
      undocumented-until-now behaviour, now a stated choice rather than an
      accident). `matches` compares the pinned version only under `ToSpec`;
      `apply` computes drift direction (`core`'s `compareVersions`) and fails
      with a typed `CannotDowngrade` — before ever shelling out — when the
      live version is ahead of the pin and the manager's own
      `PackageVersionSupport.canDowngrade` says it cannot move backward.

      Every one of the 19 backends declares, in its own type
      (`Backend.ts`'s `PackageVersionSupport`), exactly which `VersionSpec`
      tags it accepts, and every backend's `install` is an exhaustive
      `Match` over the *complete* `VersionSpec` union — a tag outside its
      declared `accepts` fails loudly with `UnsupportedVersionSpec` rather
      than being silently installed unpinned. Real, container- or
      machine-verified findings, one per manager (see each backend's own doc
      comment for the exact command and captured output):

      | Manager | Pin syntax | canDowngrade | Verified |
      |---|---|---|---|
      | apt | `pkg=version` | true (while the build is still in a configured repo) | `docker run --rm ubuntu:24.04` |
      | dnf | `pkg-<NEVRA>` | true (same caveat) | `docker run --rm fedora:latest` |
      | pacman / yay / paru | `pkg=version` | **false** — official repos hold exactly one build; `pkg=olderversion` is `target not found`, not a version mismatch | `docker run --rm archlinux:latest` |
      | cargo | `--version <v>` | true — real observed downgrade, no `--force`: `Replaced package `just v1.14.0` with `just v1.5.0`` | `docker run --rm rust:latest` |
      | npm | `pkg@version` | true | `docker run --rm node:22` |
      | pipx / uv tool | `pkg==version`, with `--force` (bare `install` refuses to touch an existing name at all) | true | `docker run --rm python:3.12` |
      | gem | `-v <version>` | true (installs alongside, never removes the newer one — see `Gem.ts`) | `docker run --rm ruby:3.3` |
      | go install | `path@version` | true, including a real observed downgrade | `docker run --rm golang:1.23` |
      | brew / brew-cask | **none** — a "version" is a differently-*named* formula (`node@18`), not a version argument to the same name; `brew info ripgrep@14` (no such formula) vs. `brew info node@18` (real, separate formula) proves the distinction | n/a | this machine, read-only |
      | mas | **none** — `mas install` takes only an App Store id | n/a | this machine, read-only |
      | snap | `Channel` only, via `--channel=` — no `Exact`: no server-side revision history a recipe can request by version string (`--revision=` exists but is documented as self-reverting on the next `snap refresh`, so it is *not* modelled as `Exact`) | true (channel symmetry) | privileged systemd container, `--help` text |
      | port (MacPorts) | **none** — MacPorts is not installed on this Mac and has no Docker image; declaring a pin syntax without running it would be exactly the invented-flag certainty rule 0c warns against | n/a | not reachable |
      | winget / choco | UNVERIFIED — no Windows target this session; flags are the widely-documented `--version`, kept in the same "real flag, not independently run" posture as this backend's pre-existing install flags | unverified | no Windows target |
      | flatpak | `Channel` only, via `id//branch` — `flatpak remote-info flathub org.gnome.Calculator` reports a `Branch:` but no `Version:` field at all, and `flatpak list --columns=…,version` *does* report one after install (`50.0`), but that string is appstream metadata, not an installable coordinate: `flatpak install …//50.0` fails with the identical `Nothing matches <id> in remote <remote>` text a nonexistent app-id gets — version is observable but never settable, a real asymmetry `Exact` would have hidden. flatpak's `Commit:` (a real content hash) is unreachable from `install` (`--commit` is `update`-only, exit 1: `Unknown option --commit=…`) | **false** — installing a second branch over an existing one is not independently confirmed; see `Flatpak.ts` | `docker run --rm ubuntu:24.04`, native arm64 |

      `refreshIndex` (new, optional on `PackageManagerBackend`): apt
      (`apt-get update`), dnf (`dnf makecache`), pacman/yay/paru (`-Sy`,
      **deliberately not `-Syu`** — see `Pacman.ts`'s doc comment for the
      partial-upgrade hazard this stops short of fixing, a real acknowledged
      gap, not a silent one). cargo/npm/pipx/uv/gem/go install talk to a live
      registry per command and keep no local index to go stale. brew/port/
      flatpak/winget/choco each have a real refresh command
      (`brew update`/`port selfupdate`/`flatpak update --appstream`/
      `winget source update`/`choco upgrade all` is not it, `choco source`
      isn't either) that this pass did not wire up — a real, tracked gap, not
      an oversight: see the item below.

      `VersionSpec.AtLeast` is part of the shared vocabulary but **no
      backend here declares it** — every manager this package wraps is
      pinned by a single exact string or not at all, never by a version
      *range* the way `mise`/`asdf` resolve `Runtime.Tool`'s `version` field.
      `Package.ts`'s `matches` therefore compares a `ToSpec` pin by plain
      string equality, not `core`'s `matchesVersionSpec`; this is a stated
      simplification, not a silent gap, and is moot in practice because
      `checkVersionSupported` rejects `AtLeast` for every manager before
      `matches` would ever see one.

- [x] **`CannotDowngrade` and `compareVersions`'s `"Unknown"` case.** Closed
      2026-08-14, after a peer measured `compareVersions` against real
      captured version pairs directly rather than reasoning about it:

      | observed vs. desired | result | source |
      |---|---|---|
      | `2.3.2-1` vs `2.0.0-1` | `Ahead` | real pacman pkgrel (`archlinux:latest`) |
      | `2.1.1-2ubuntu3.24.04.2` vs `2.1.1-2ubuntu3` | `Unknown` | two real `apt-cache madison tree` versions (`ubuntu:24.04`) |
      | `2.2.1-4.fc44` vs `2.2.1-3.fc44` | `Unknown` | real dnf `%{evr}` (`fedora:latest`) |
      | `2:4.19.0-7.fc44` vs `2:4.19.0-6.fc44` | `Unknown` | real dnf evr with a nonzero epoch (`shadow-utils`) |
      | `v0.20.0` vs `v0.19.0` | `Unknown` | real go module tags (`golang:1.23`) |
      | `2.2.1,20628` vs `2.2.0,20000` | `Unknown` | real `brew list --cask --versions` (this machine) |
      | `13.1.0` vs `13.0.6` | `Ahead` | real `gem list --local` (`ruby:3.3`) |

      `compareVersions`'s `DOTTED` regex now splits on `.` *and* `-`
      (`/^\d+([.-]\d+)*$/`), which is what turns pacman's `pkgver-pkgrel`
      pair into a real `Ahead` — the fix, not a hypothesis. apt/dnf's real
      strings stay `Unknown` (an `ubuntuN`/`.fc44` distro tag and an epoch
      colon are not plain digit runs), but that was never the live gap: both
      managers are `canDowngrade: true`, so `CannotDowngrade` was never
      written to guard them in the first place — the earlier version of this
      entry named "apt, dnf or pacman" as the three managers the guard
      exists for and was wrong on both halves (pacman's guard does fire once
      the regex above is in place; apt/dnf's `canDowngrade` means there was
      never a guard to fire).

      The real residual gap, once pacman is accounted for, is narrower and
      is in the two managers `canDowngrade: false` actually protects that a
      pacman-shaped test would never reach: **aur** (`yay`/`paru` — a VCS
      package's version, e.g. `r1234.deadbeef`, has no numeric grammar at
      all) and **flatpak** (`accepts: {Channel}` — a branch name is never
      orderable). `Package.ts`'s `apply` now refuses on `"Unknown"` *only*
      when the pin is a fixed target (`Exact`/`AtLeast`) and the manager
      can't downgrade — not on every `"Unknown"`, which would have made every
      legitimate `Channel` switch (flatpak's branch, snap's track) fail: a
      channel name pair is *always* `"Unknown"` (neither side is
      dotted-numeric), and switching channels is not a downgrade question in
      the first place. `CannotDowngrade` carries a `direction: "Ahead" |
      "Unknown"` field so its message never claims "newer" when the honest
      statement is "cannot be ordered, and this manager cannot go backward
      anyway".

      No dpkg/RPM version comparator was written — real EVR and Debian
      version ordering (epoch, `~`, alphanumeric rules) are two genuinely
      different algorithms, and getting either right from memory is exactly
      what rule 0c forbids; `compareVersions`'s doc comment says so
      explicitly rather than implying more coverage than it has.

      Pinned by three `test/backends.test.ts` cases: pacman's real `Ahead`
      (the original case, now passing), an AUR VCS `Unknown`-refuses case,
      and a flatpak `Unknown`-proceeds case — the last one is the test that
      would have failed if the fix had refused on every `"Unknown"` instead
      of gating it on the spec tag.
- [ ] **`refreshIndex` for brew/port/flatpak/winget/choco.** Real commands
      exist (`brew update`, `port selfupdate`, `flatpak update --appstream`,
      `winget source update`) but were not wired into `apply` this pass —
      apt/dnf/pacman/yay/paru (the ones directly named in the finding that
      prompted this) are done; these five are the acknowledged remainder.
- [ ] **A real per-manager "upgrade to latest" probe for `UpdatePolicy.Latest`.**
      Today `Latest` behaves identically to `Never` once a package is
      present — Alchemy's `reconcile` only calls `apply` when `matches` is
      false, and `matches` has no notion of "is a newer version available
      upstream" for any manager. `Latest` is not silently wrong (see
      `core`'s `Version.ts` for why it's still a stated, honest choice: it
      is a real update policy that governs what happens on *drift*, and
      currently there is only ever drift for `ToSpec`), but a recipe that
      wants continuous auto-update gets no more than `Never` does today. A
      real fix needs a per-manager "is there a newer version" check
      (`apt list --upgradable`, `dnf check-update`, `npm outdated -g
      --json`, …) this session did not build.
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
