# `@machine-run/system-packages` — backlog

`System.Package` / `System.Repo` over a `PackageManagerBackend` seam.
Backends are split per OS under `src/backends/{macos,linux,windows,language}/`.
See `docs/notes/system-packages-notes.md` for what has been run against a
real tool and what hasn't.

## Open work

- [ ] **`paru`.** `~` — `paru-bin` installs but fails to run (`libalpm.so.15`
      ABI mismatch in this container); building from source compiles but its
      release LTO link hasn't finished in-session. See `Aur.ts`'s doc comment.
- [ ] **MacPorts against a real `port`.** Not installed here, no Docker
      image; verify the `port installed` header/column shape and a pin
      syntax (none declared yet).
- [ ] **`winget export` rather than `winget list`.** `list` truncates a long
      id with an ellipsis that eats the column padding, so that package
      reads as not-installed and gets a no-op reinstall every deploy.
      `export` emits full ids as JSON but writes to a file, not stdout —
      needs a temp path through the `exec` seam.
- [ ] **`winget install` / `choco install` flags are unverified.** Only
      `list` has been exercised against a real Windows target (CI); nothing
      has installed a package via either backend.
- [ ] **`refreshIndex` missing for 13 of 17 backends.** Implemented only for
      apt, dnf, pacman, and aur (covers yay + paru). brew, MacPorts, mas,
      choco, winget, flatpak, snap each have a real refresh command
      (`brew update`, `port selfupdate`, `flatpak update --appstream`,
      `winget source update`, …) not wired in — a real gap.
      cargo/npm/pipx/uv-tool/gem/go-install talk to a live registry per
      command and keep no local index to go stale, so they're excluded by
      design, not by gap.
- [ ] **No real "is a newer version available" check for
      `UpdatePolicy.Latest`.** `matches` never asks upstream, so `Latest`
      behaves exactly like `Never` once a package is present. Needs a
      per-manager probe (`apt list --upgradable`, `dnf check-update`, `npm
      outdated -g --json`, …).
- [ ] **No dpkg/RPM version comparator.** `compareVersions` only splits on
      `.`/`-`, which covers pacman's `pkgver-pkgrel`; real epoch/`~`/
      alphanumeric Debian and RPM ordering is unimplemented, so apt/dnf
      pairs compare `Unknown` (harmless today — both are `canDowngrade:
      true`, so `CannotDowngrade` never needs to fire for them).
- [ ] **`VersionSpec.AtLeast` has no backend that accepts it.** Every
      manager here pins by exact string or not at all;
      `checkVersionSupported` rejects `AtLeast` before `matches` would ever
      see one.
- [ ] **`nix` unaddressed.**
- [ ] **Implement `list`** so an existing machine can be inventoried into a
      starting recipe. Currently the engine's default empty implementation.
- [ ] **Flatpak repo drift never resolves.** `remote-add`'s standard
      Flathub bootstrap URL never equals what `flatpak remotes` reports
      back, so a `System.Repo` written with the bootstrap form always plans
      as needing an update (harmless — `--if-not-exists` keeps `apply`
      idempotent). Using the resolved URL instead avoids that but fails GPG
      verification without `--no-gpg-verify`.
