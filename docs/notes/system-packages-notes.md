# system-packages: verification status and CLI notes

Docker (OrbStack) makes most of Linux reachable from this Mac, and several
tools are directly installable here too (`brew`, `uv`, `gem`, plus anything
`brew install`s cleanly: `pipx`, `go`, `mas`). What's genuinely out of reach —
Windows, and Linux tooling that needs a running `systemd`/`snapd` a plain
container doesn't provide — is called out explicitly below rather than
presented as checked. Every backend's own module doc comment in
`src/backends/**/*.ts` repeats the specific verification for that backend;
this file is the cross-backend summary plus anything that doesn't fit neatly
next to one file (the dnf/pacman "repo" coverage decision, the two
correctness fixes below).

## dnf and pacman (`src/backends/linux/{Dnf,Pacman}.ts`)

Both verified against real containers
(`docker run --rm fedora:latest` / `docker run --rm --platform linux/amd64
archlinux:latest` — Arch has no `arm64` image, hence the explicit platform).

**Fedora 44's `dnf` is `dnf5`** (`/usr/bin/dnf` → `dnf5`; `dnf --version`
prints `dnf5 version 5.4.2.1`). This mattered because dnf5 rewrote large
parts of dnf in Rust with a different plugin architecture — but the specific
commands this package uses (`dnf repoquery --userinstalled --qf '%{name}\n'`,
`dnf install -y <name>`) are exactly the dnf4 CLI surface dnf5 keeps
compatible, and both worked as documented: a fresh container's
`repoquery --userinstalled` printed the base image's own packages, and
`tree` appeared in it immediately after `dnf install -y tree`. RHEL/CentOS
(still dnf4 as of this writing) wasn't independently checked, but nothing
here is dnf5-specific.

**pacman's `-Qq` genuinely returns every installed package, dependencies
included** — 137 names on a freshly-synced fresh image, growing by exactly
one after `pacman -S tree`. This is the same "installed at all, regardless of
why" semantics apt's `dpkg-query` already has, and is what this package wants
(membership, not provenance). The `warning: database file for '...' does not
exist` lines pacman prints before a first `-Sy` were confirmed to go to
stderr only, never stdout.

One container-only quirk, unrelated to either package manager: `pacman -Sy`
failed with `error: error restricting syscalls via seccomp: 22!` under this
sandbox's default seccomp profile. `pacman -S --help` documents
`--disable-sandbox` for exactly this ("disables all sandbox features used for
the downloader process"), and passing it made every real install in this
session work. This is a Docker/CI artifact of the *test* environment, not
something `Pacman.ts`'s `install` needs to pass on a real machine.

## `System.Repo` coverage: dnf yes, pacman no (`src/Repo.ts`)

`RepoManagerId` now includes `"dnf"`. COPR (`dnf copr enable`/`dnf copr
list`) is dnf's real equivalent of a brew tap or an apt PPA — a third-party
repo the manager itself tracks as configuration, independent of what's
installed from it. Verified on the same Fedora 44 container:
`dnf copr enable -y atim/lazygit` wrote a real `.repo` file under
`/etc/yum.repos.d/` and made `dnf install -y lazygit` resolve; `dnf copr
list` afterwards printed exactly `copr.fedorainfracloud.org/atim/lazygit` —
one clean `hub/owner/project` line per enabled project, no header. Since a
recipe names a COPR as `owner/project` (the form `dnf copr enable` itself
documents as primary) but the listing is always hub-qualified, `Dnf.ts`'s
`listRepos` reports both the raw line and its trailing `owner/project` form,
the same two-forms trick `Apt.ts`'s `listRepos` already uses for `ppa:`
shorthand vs. the raw source line.

**pacman stays out of `RepoManagerId`, and this is a decision, not a gap.**
The AUR — the only "extra repo" pacman users reach for — has no equivalent to
tap/PPA/COPR: an AUR helper (`yay`/`paru`) clones a PKGBUILD and runs
`makepkg` locally, then hands pacman an ordinary local package to install.
Nothing gets written to `/etc/pacman.conf` or any pacman-tracked repo list —
confirmed while building `yay-bin` straight from the AUR in the same Arch
container — so there is nothing for `listRepos` to observe or `addRepo` to
create. Wanting an AUR package is expressed as a `System.Package` on manager
`"yay"`/`"paru"` (see below) with no separate "enable the AUR" step, unlike
COPR or a PPA.

## New package-manager backends

All verified either against a real local install or a real container run;
see each backend's own module doc comment in `src/backends/**/*.ts` for the
specific commands and captured output. Summary:

- **`pipx`** (`backends/language/Pipx.ts`) — verified locally (macOS,
  `brew install pipx`). `pipx list --short` / `pipx install <name>`.
- **`uv-tool`** (`backends/language/UvTool.ts`) — verified locally (`uv`
  already installed here). `uv tool list` / `uv tool install <name>`.
- **`gem`** (`backends/language/Gem.ts`) — verified locally (macOS system
  Ruby 2.6.10). `gem list --local` / `gem install --user-install <name>` —
  `--user-install` because a plain `gem install` failed here with
  `Gem::FilePermissionError` (SIP-protected system gem directory); it also
  works when that protection doesn't apply, so it's the safer default over
  falling back to `sudo`.
- **`go-install`** (`backends/language/Go.ts`) — verified locally (macOS,
  `brew install go`). No `list` command exists for `go install`'d binaries at
  all; this reads `go version -m` on every file in `$GOBIN`/`$GOPATH/bin`,
  which embeds the exact import path a binary was built from — the only way
  to recover the identifier `install` itself needs (a bare filename like
  `goimports` isn't `golang.org/x/tools/cmd/goimports`, which `go install`
  requires and `props.name` is set to).
- **`mas`** (`backends/macos/Mas.ts`) — `list` verified against this real,
  already-signed-in machine's actual `mas list` output. `install` was
  **not** run — unlike every other backend here, it would durably install a
  real app under a real Apple ID, the kind of side effect worth avoiding
  without it being what was actually asked for — so it's verified against
  `mas install --help`'s own text instead (`mas install <id>`, requires
  root). Recipes using this backend still need the machine already signed
  into an Apple ID by hand; `mas` dropped its own `signin` command years ago
  and nothing here should try to automate that.
- **`yay`/`paru`** (`backends/linux/Aur.ts`) — verified building `yay-bin`
  from the real AUR in the Arch container (see above). `list` uses
  `pacman -Qmq` (foreign packages) rather than either helper's own query
  mode — confirmed to correctly exclude an official-repo package
  (`cmatrix`, installed via `yay -S`) while including the AUR-built
  `yay-bin` itself. `paru`'s CLI is documented as pacman/yay-compatible for
  `-S`/`--noconfirm` but wasn't independently built and run here.
- **`flatpak`** (`backends/linux/Flatpak.ts`) — partially verified
  (`docker run --rm ubuntu:24.04`, flatpak 1.14.6): confirmed flags via
  `--help` and a real *empty* listing (`flatpak list --app
  --columns=application` → nothing, exit 0). A *populated* listing's real
  shape was not captured: every flatpak app pulls a multi-hundred-MB runtime
  on first install, and that download didn't finish inside this session's
  time/network budget across several attempts. Also: `install` takes no
  remote argument, so it only resolves when exactly one configured remote
  (commonly Flathub) offers that app ID — there's no `System.Repo` wiring
  for Flatpak remotes, which is a real gap (unlike pacman/AUR's absence,
  which is a decision).
- **`snap`** (`backends/linux/Snap.ts`) — **UNVERIFIED, same category as
  Winget/Choco below.** `snap` fundamentally needs a running `snapd`, which
  needs `systemd` and its own mount namespaces — a plain container doesn't
  provide either, which is itself a widely-documented snap-in-Docker
  limitation. This was still attempted rather than assumed: `apt-get install
  snapd` inside `ubuntu:24.04` timed out repeatedly within this session's
  time budget before `snap version` ever returned, both with and without
  manually starting `snapd`, and no `--help` output was captured either.
  Consistent with the known limitation, but not a clean confirmation of it —
  genuinely unverified, not "confirmed unsupported in Docker." The backend
  is implemented against `snap list`'s and `snap install`'s widely-published
  documented shapes (a header row + one row per snap; `sudo snap install
  <name>`), same as this file's Winget/Choco sections, and its module doc
  comment says so plainly. Its test coverage is limited to the trivial
  empty-input case for exactly this reason — no populated fixture exists to
  test the header-stripping logic against.

## Winget (`src/backends/windows/Winget.ts`)

No Windows/`winget` install available to verify against.

- `winget list --accept-source-agreements` — widely documented; needed so a
  first run doesn't block on an interactive source-agreement prompt.
- `winget install --id <id> --exact --accept-package-agreements
  --accept-source-agreements --silent --disable-interactivity` — the
  documented combination for a non-interactive install. `--exact` is used
  deliberately (not fuzzy name matching) because `parseWingetList`'s
  fixed-width table parse is itself unverified — an `--exact` id match means a
  parse mistake fails loudly (unknown id) rather than installing the wrong
  package.
- winget has no `--json`/machine-readable list output as far as the
  documentation shows; `parseWingetList` parses the human-readable table
  instead (see its doc comment for the parsing approach and its failure
  modes).

## Chocolatey (`src/backends/Choco.ts`)

No Windows/`choco` install available to verify against.

- `choco list --local-only --limit-output` — `--limit-output`/`-r` is
  documented as Chocolatey's stable machine-parseable `name|version` output.
  `--local-only` is documented for older Chocolatey versions; some v2 builds
  made `choco list` local-only by default and deprecated the flag but accept
  it as a no-op rather than an error, so passing it explicitly is expected to
  be safe across versions per the documentation — not confirmed here.
- `choco install <name> -y` — `-y`/`--yes` (skip the confirmation prompt) is
  the documented non-interactive flag.

## Apt (`src/backends/Apt.ts`)

`apt-add-repository --list` was considered for `listRepos` and rejected: its
output format isn't documented as stable across distro versions, and this
machine has no apt install to check it against. `listRepos` instead reads
`/etc/apt/sources.list` and `/etc/apt/sources.list.d/*.list` directly — a
stable, documented format (`sources.list(5)`). This does not read the newer
deb822 `*.sources` block format (default on Ubuntu 24.04+); a PPA added only
in that form won't be recognised as already-present, so the worst case is a
redundant (idempotent) `add-apt-repository` call, not a wrong one. See
`parseAptSources`'s doc comment for the parsing details.

## Verified elsewhere

Everything else in `src/backends/` (Brew, MacPorts/`port`, Dnf, Pacman,
Cargo, Npm, and every backend added in the "New package-manager backends"
section above except `winget`/`choco`/`snap`) uses flags checked against real
installs or real containers, and isn't repeated here.

## Two correctness fixes

**Tap-qualified brew names (`backends/macos/Brew.ts`).** `brew list
--formula` reports every formula by its bare name regardless of tap, so a
recipe naming a third-party formula `owner/tap/formula` — which `install`
needs, to disambiguate from a same-named `homebrew/core` formula — never
found itself in that listing and reinstalled on every apply. Fixed by adding
`--full-name`. Verified locally: after tapping `koekeishiya/formulae` and
installing `koekeishiya/formulae/skhd`, plain `brew list --formula` reported
it as bare `skhd`, while `--full-name` reported the qualified name — and,
for `homebrew/core` formulae (the implicit default tap), `--full-name` still
reports the bare name with no `homebrew/core/` prefix, so unqualified
recipes are unaffected.

**`npm ls -g` exits non-zero on any tree problem (`backends/language/
Npm.ts`).** `npm ls -g --depth=0 --json` exits 1 (`ELSPROBLEMS`) whenever the
global tree has *any* problem — an unmet peer dependency chief among them —
which previously turned a perfectly good listing into a `CommandError` and
failed observation for every declared npm package, not just whichever one
triggered the problem. Reproduced locally (npm 11.17.0) with a project
depending on a package whose peer dependency nothing satisfies: `npm ls
--json` exits 1 with `npm error code ELSPROBLEMS` on stderr, but stdout still
holds the complete, well-formed listing (plus an added top-level
`problems`/`error` key). Alchemy's `CommandError` for a non-zero exit only
carries `exitCode`/`stderr` — never `stdout` — so once npm's exit code
reaches Alchemy the listing is unrecoverable; the fix keeps it from reaching
Alchemy at all, the same `shell: true` + `; true` idiom `Apt.ts`'s
`listRepos` already uses for its own optional globs.

## `System.Package`/`System.Repo` on `@machine-run/engine`'s `Reconciler`

`Package.ts` and `Repo.ts` are built on `toProvider`/`Reconciler` (see
`packages/dotfiles/src/File.ts` for the pattern). Two decisions worth writing
down, since neither is the "obvious" default:

**`address` is the manager id, not `manager:name`.** apt/dpkg holds one
global lock (`/var/lib/dpkg/lock-frontend`); two concurrent `apt-get install`
calls fail outright rather than queueing. Homebrew is also unhappy with
concurrent installs. Alchemy reconciles independent resources with
`concurrency: "unbounded"`, so a recipe declaring N packages on one manager
would otherwise fire N concurrent installs. Using the bare manager id
(`"brew"`, `"apt"`, …) as `address` makes the engine's own address-based
locking serialise every package (and every repo — `Repo.ts` uses the same
scheme, so a `brew tap` and a `brew install` also serialise against each
other) on one manager through a single queue, while packages on *different*
managers still reconcile in parallel. The cost: installs on the same manager
never overlap even when the tool could safely run two at once — correctness
over throughput, and cheap, since holding the lock only serialises other
installs on that same manager.

**`observe`'s memoized listing needs a plan-phase and an apply-phase
instance, not one shared cache.** `toProvider` calls a reconciler's `observe`
from two distinct moments: once per resource up front to build the plan
(passing an `ObserveContext`), and again, per resource, immediately before
deciding whether to `apply` (`reconcile`'s re-observe, passing the wider
`ApplyContext`). Those two moments are not adjacent in time — a plan can be
reviewed before being applied. If the second observe reused a listing cached
by the first, a package uninstalled in that gap would still read as
"present" at apply time, and the whole point of consulting a live listing
(catching drift a stale `output` prop can't) would be defeated. `Package.ts`/
`Repo.ts` tell the two phases apart by checking whether the `ObserveContext`
they were handed is actually the wider `ApplyContext` (`"snapshot" in ctx` —
only `ApplyContext` has it), and route to a separate `PackageIndex` per
phase. See `PackageIndex.ts`'s own doc comment for the full mechanics.
`apply` always invalidates the apply-phase index after a real install/`add`,
so a sibling resource on the same manager, reconciled right after under the
same address lock, never sees a pre-install snapshot.

Both resources' backends (`src/backends/*.ts`) no longer take a
`CommandExecutor`/session at construction; each method takes an `Exec`
(`@machine-run/engine`'s own type — the reconciler's command-running
capability, already bound to the right session by the engine) per call, so a
backend can never run a command outside the reconciler's own bookkeeping.
