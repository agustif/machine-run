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

## Version pinning

`Package`'s `version` prop takes `@machine-run/core`'s `VersionSpec` —
`Exact`, `AtLeast`, `Channel`, or `Digest` — and `updatePolicy` takes its
`UpdatePolicy` — `Never` (default: install once, then leave drift alone),
`ToSpec` (reinstall on any mismatch), or `Latest` (always resolve to
whatever the manager considers newest). Neither field is required; omitting
`version` keeps the original "whatever the manager resolves as current"
behaviour.

Not every manager accepts every spec, and each backend declares its own
accepted subset via `Backend.ts`'s `PackageVersionSupport` — `snap` only
takes `Channel`, `mas` takes no version at all, pacman's official repos only
ever satisfy `Exact` when it names the version already current. Naming a
spec a backend can't honour fails loudly with `UnsupportedVersionSpec`
rather than installing unpinned; asking for a downgrade a backend can't
perform fails with `CannotDowngrade` (which carries a `direction`).

```ts
import * as SystemPackages from "@machine-run/system-packages";

yield *
  SystemPackages.Package("ripgrep-pinned", {
    manager: "brew",
    name: "ripgrep",
    version: { _tag: "Exact", version: "14.1.0" },
    updatePolicy: { _tag: "ToSpec" },
  });
```

## Verification status

Per [docs/MAP.md](../../docs/MAP.md) §4, verification is tracked per backend,
not per package — this package's 19 ids are at very different points:

|          | Verified (`✓`)                                         | Written, never run (`~`) | Known broken (`!`) |
| -------- | ------------------------------------------------------ | ------------------------ | ------------------ |
| macOS    | `brew`, `brew-cask`, `mas` (list only)                 | `port` (MacPorts)        |                    |
| Linux    | `apt`, `dnf`, `pacman`, `yay`, `flatpak`, `snap`       | `paru`                   |                    |
| Windows  | `winget` (inventory), `choco`                          |                          |                    |
| language | `cargo`, `npm`, `pipx`, `uv-tool`, `gem`, `go-install` |                          |                    |

Three backends are worth calling out specifically:

- **`winget` (inventory only)** — reconciliation now uses the real nested
  `winget export` JSON surface through a scoped temporary file, so the
  fixed-width table's truncated identifiers cannot make installed packages
  look absent. The old `list` parser remains as a captured-output regression
  diagnostic; `winget install` itself has never been run against a real
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

`System.Package` is also the one resource kind in this package to have gone
through an actual `plan`/`deploy`/second-plan-is-empty/`destroy` cycle
end-to-end (`scripts/deploy-check.sh`); `System.Repo` has not.

## What it deliberately does not do

- **No `list`/inventory.** A real machine can't yet be scanned into a starting
  recipe; every resource address has to be written by hand.
- **No `unapply`.** Uninstalling a package someone else may now depend on is
  not an obvious, safe reversal of a recipe line being removed — see
  [../../docs/MAP.md](../../docs/MAP.md) §5.

See [TASKS.md](./TASKS.md) for the rest, including the AUR/MacPorts/brew-cask
gaps in detail.
