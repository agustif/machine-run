# `@machine-run/system-packages`

Reconciles installed packages and third-party repositories across package
managers on macOS, Linux, Windows, and language-level tools. Each package or
repo is its own atomic resource — never a bundle that owns a list — so one
package failing to install doesn't take the rest of a plan down with it, and
drift is reported per package.

## What it exports

| Export                                     | What it's for                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `Package` (`System.Package`)               | One installed package, from one manager                                                               |
| `Repo` (`System.Repo`)                     | One tap/PPA/COPR/Flatpak remote — a manager's own "extra repo" concept                                |
| `packages(manager, names)`                 | Sugar over N independent `Package` resources — a plain loop, not a bundle resource                    |
| `repos(specs)`                             | Sugar over N independent `Repo` resources                                                             |
| `detectSystemPackageManager` (`detect.ts`) | Picks a manager id from `process.platform`, for a recipe that wants one default without naming its OS |

19 manager ids exist: `brew`, `brew-cask`, `port`, `mas`, `apt`, `dnf`,
`pacman`, `yay`, `paru`, `flatpak`, `snap`, `winget`, `choco`, `cargo`, `npm`,
`pipx`, `uv-tool`, `gem`, `go-install`. Four (`brew`, `apt`, `dnf`, `flatpak`)
also support `Repo`.

## Example

From `examples/complete-machine/recipes/packages.ts`:

```ts
import * as SystemPackages from "@machine-run/system-packages";

// A third-party tap. `manager` is explicit rather than detected, because a
// repo's addressing scheme is manager-specific.
yield *
  SystemPackages.Repo("homebrew-tap", {
    repo: { _tag: "Brew", tap: "homebrew/cask-fonts" },
  });

// One package, stated on its own, so its drift is independently visible.
yield * SystemPackages.Package("ripgrep", { manager: "brew", name: "ripgrep" });

// The common case: a list from one manager, each becoming its own resource.
yield * SystemPackages.packages("brew", ["fd", "jq", "mise"]);
```

## Verification status

Per [docs/MAP.md](../../docs/MAP.md) §4, verification is tracked per backend,
not per package — this package's 19 ids are at very different points:

|          | Verified (`✓`)                                         | Written, never run (`~`) | Known broken (`!`) |
| -------- | ------------------------------------------------------ | ------------------------ | ------------------ |
| macOS    | `brew`, `brew-cask`, `mas` (list only)                 | `port` (MacPorts)        |                    |
| Linux    | `apt`, `dnf`, `pacman`, `yay`, `flatpak`, `snap`       | `paru`                   |                    |
| Windows  | `choco`                                                |                          | `winget`           |
| language | `cargo`, `npm`, `pipx`, `uv-tool`, `gem`, `go-install` |                          |                    |

Three backends are worth calling out specifically:

- **`winget` (`!`)** — its `list` parser is verified against real Windows
  runner output, and that verification found a real, only-partly-fixable bug:
  `winget list` truncates an over-long id with an ellipsis that eats the
  column padding, so a truncated id simply isn't recoverable from the table.
  Those packages read as _not installed_ and get re-installed on every apply.
  The real fix is `winget export`, which emits full ids as JSON — not started
  (`docs/TASKS.md`). `winget install` itself has never been run against a real
  package.
- **`paru` (`~`)** — attempted twice. `paru-bin` built and installed cleanly
  but failed to _run_ (`libalpm.so.15` missing, a real ABI mismatch). Building
  `paru` from source compiled through its whole ~140-crate dependency tree but
  didn't finish its release-mode LTO link inside the session's time budget.
  See `docs/notes/system-packages-notes.md`.
- **`snap` (`✓`)** — a plain container genuinely cannot reach a running
  `snapd`, but a privileged, systemd-booted one can (`docker run --privileged
--cgroupns=host` with a real `/sbin/init` PID 1) — the same technique
  `system-services`' `systemd-user` backend already relies on. `snap install
hello-world` ran snapd's real first-install bootstrap and the installed
  snap actually executed. See `docs/notes/system-packages-notes.md`.

## What it deliberately does not do

- **No version pinning.** `PackageProps` has no `version` field — "install
  ripgrep" cannot yet mean a particular ripgrep. `matches` is membership
  ("is it installed"), not a version comparison. Tracked in
  [TASKS.md](./TASKS.md).
- **No `list`/inventory.** A real machine can't yet be scanned into a starting
  recipe; every resource address has to be written by hand.
- **No `unapply`.** Uninstalling a package someone else may now depend on is
  not an obvious, safe reversal of a recipe line being removed — see
  [../../docs/MAP.md](../../docs/MAP.md) §5.

See [TASKS.md](./TASKS.md) for the rest, including the AUR/MacPorts/brew-cask
gaps in detail.
