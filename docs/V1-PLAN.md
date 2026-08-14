# machine-run → v1

What a fully configured machine needs, and what this repo doesn't cover yet.
Everything not listed below is built — see [MAP.md](./MAP.md) for the full
inventory with verified-versus-written status per item, and
[TASKS.md](./TASKS.md) for a fine-grained worklist.

The rule that keeps this from sprawling: **a new domain package may not
introduce a new engine concept.** It composes primitives and dispatches
through a backend seam. A genuinely new resource type needs an explicit
justification, because every resource type is a permanent state-schema
commitment.

---

## Domain gaps

| Area | Missing |
|---|---|
| Identity & auth | GPG keyring/trust management; ssh-agent config; cloud profiles (aws/gcloud/az); kubeconfig contexts |
| Software | Nix/home-manager; `composer`; container runtimes (docker/orbstack/colima); pacman/COPR repo management (apt, dnf and flatpak have it) |
| Shell & terminal | prompt (starship/p10k); completions; terminal emulator config (ghostty/wezterm/kitty/iterm); multiplexer (tmux/zellij) |
| Editors & dev tooling | VS Code/Cursor settings + extensions; JetBrains/neovim; direnv; EditorConfig |
| OS settings | macOS: hostname, pmset, firewall, keyboard remap (hidutil), login items — none go through `defaults`, so the generic `System.Setting` backend doesn't reach them; Linux: sysctl, udev; Windows: registry |
| Services & scheduling | cron |
| Network | `/etc/hosts`; DNS/resolver; VPN/proxy/wifi |
| Filesystem | archive extraction |
| Assets | fonts; wallpapers/icons |
| Operations | drift report / doctor command; inventory enumeration — no reconciler implements `list`, though adopt via `read` now works generically for every resource through the engine adapter; publish readiness (license is `UNLICENSED`, version `0.0.0`) |

### Backend/seam gaps

- **Secrets**: bitwarden, AWS Secrets Manager, HashiCorp Vault (only 1Password, Doppler, Keychain, env and pass exist)
- **Settings**: no Windows registry backend (only `defaults`, gsettings, dconf)

---

## Manifest resources — designed, not built

Two layers of package identity are legitimate and complementary:

| Layer | Unit of identity | Good for |
|---|---|---|
| **Atomic** — `System.Package` (built) | one installed package | fine-grained drift detection, mixing managers, per-package conditionals |
| **Manifest** — `Brew.Bundle`, `Mise.Toml`, `Asdf.ToolVersions`, `Nix.Flake`, `Code.Extensions` (not built) | one real ecosystem file | matching how the ecosystem actually works, `cleanup` semantics, sharing the file with non-machine-run tooling |

A manifest resource must model a file the ecosystem itself defines, have a
real idempotent apply, and not silently fight the atomic layer — a recipe
managing both a `Brewfile` and atomic `System.Package`s for brew is a
conflict that machine-run should detect and refuse rather than let two
writers race.

---

## Design questions still open

- **Secret rotation is undetectable by construction.** `SecretFile` diffs on
  existence, mode and `ref`, never content — hashing would put secret-derived
  data into unencrypted state. Rotating a value behind an unchanged `ref` is
  invisible. Unexplored: ask the *store* when the item last changed (1Password
  exposes item version metadata) instead of the value itself.
- **Ordering in shared files is opt-in, and forgetting is silent.**
  `ManagedBlock.after` manufactures the dependency edge that makes ordering
  deterministic; nothing requires it, so two unordered regions in one file get
  an arbitrary winner with no warning.
- **`-array-add`/`-dict-add` are additive**, so for array/dict `defaults`
  values `matches` becomes "contains" rather than "equals" — a different
  reconciler contract than everywhere else. Needs an explicit `mode` prop
  rather than a silent merge.
- **Reversibility (`unapply`) is implemented for 3 of 23 resource kinds**
  (`Shell.Login`, `Git.Maintenance`, `System.Setting`). The remaining 20
  don't: reverting a `defaults` key has no defined "before" if the original
  was never recorded, and restoring a backup is only right if the backup is
  still the right answer.
- **Resource type naming has nine conventions** (`Machine.*`, `System.*`,
  `MacOS.*`, `Tailscale.*`, `Git.*`, `Ai.*`, `Runtime.*`, `Shell.*`, `Ssh.*`)
  and no rule for when something is `Machine` versus `System`. Renaming is no
  longer a state-schema break — `Resource(type, { aliases })` covers
  pre-rename names, proven in `packages/engine/test/aliases.test.ts` — so this
  is a naming-hygiene decision, not a release blocker.

---

## Known limitations

- `sudo` is hardcoded at 10 call sites (Snap 3, Pacman 3, Dnf 3, Mas 1),
  absent from Flatpak; runs even when already root.
- No `LC_ALL`/`LANG` anywhere, while many backends parse localised CLI output.
- 57 hardcoded timeout literals across 6 distinct values.
- `matches` returns a bare `boolean`, `address` a bare `string` — the engine
  knows *that* something drifted, never how or in which direction.
- Windows: 16 tests across 7 files fail. Node reports `0o666` for every file
  and `chmod` only toggles read-only, so a pinned `mode` can never be observed
  back. Design decided in [notes/windows-permissions.md](./notes/windows-permissions.md),
  not built.
