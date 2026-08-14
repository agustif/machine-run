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
  already-signed-in machine's actual `mas list` output, re-captured this
  session as `test/fixtures/mas-list.txt` (seven apps now, up from three;
  identical shape). `install` was **not** run, on this second look either —
  unlike every other backend here, it would durably install a real app
  under a real Apple ID, the kind of side effect worth avoiding without it
  being what was actually asked for — so it's verified against a freshly
  re-run `mas install --help`'s own text instead (`mas install <id>`,
  requires root, output unchanged from the first verification). This is a
  deliberate, permanent boundary for this backend, not a gap: `mas install`
  needs root and durable account-linked state, and nothing about a second
  pass changes that. Recipes using this backend still need the machine
  already signed into an Apple ID by hand; `mas` dropped its own `signin`
  command years ago and nothing here should try to automate that.
- **`brew-cask`** (`backends/macos/Brew.ts`) — read-only verified this
  session against this real machine's actual `brew list --cask` output
  (thirteen already-installed casks, fixture:
  `test/fixtures/brew-list-cask.txt`). Previously only exercised as part of
  `brew`'s own verification; the two differ where it matters. `brew list
  --cask` prints one bare cask token per line — no header, no version
  column, same shape a plain (non-`--full-name`) `brew list --formula`
  would have — so the existing `lines()` parser needed no change. `install`
  was **not** run: this is a Mac, not a container, so nothing here mutates
  it, and a cask install specifically (unlike a formula) can require a GUI
  prompt or admin password (Gatekeeper/notarization, or a `.pkg` installer
  some casks shell out to) that this backend's non-interactive `install`
  cannot satisfy regardless — a real, structural difference from `brew`
  worth recording, not just an unexercised code path.
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
  (commonly Flathub) offers that app ID.

  **Remote (`System.Repo`) support added and verified 2026-08-14**, closing
  the gap named above (`docker run --rm --platform linux/amd64 ubuntu:24.04`,
  same flatpak 1.14.6). `RepoManagerId` now includes `"flatpak"`;
  `Flatpak.ts` grew `listRepos`/`addRepo`. Real captured output committed as
  `test/fixtures/flatpak-remotes{-empty,}.txt` and pinned by
  `test/backends.test.ts`, following the exact `languageBackends.test.ts`
  fixture pattern.

  What running it (rather than reading `--help`) actually found:
  - `flatpak remotes --columns=name,url` prints a real *blank line* on an
    empty install (not zero bytes) — a subtler shape than `flatpak list`'s
    genuinely empty stdout, and now the empty fixture, not an assumption.
  - `flatpak remote-add NAME LOCATION` with the standard, documented
    bootstrap URL (`https://dl.flathub.org/repo/flathub.flatpakrepo`)
    succeeds, but `flatpak remotes` afterward reports the *resolved*
    underlying repo URL (`https://dl.flathub.org/repo/`) — a different
    string flatpak fetched out of the bootstrap file, which it never stores
    the original of anywhere. This is the same "canonical form differs from
    what you typed" hazard `system-settings`' GVariant work hit, except here
    there is no safe canonical spelling that both matches *and* stays
    correctly signed: adding the *resolved* URL directly instead fails GPG
    signature verification (`Can't check signature: public key not found`,
    exit 1) unless `--no-gpg-verify` is also passed, which is a real
    security downgrade, not a fix. `addRepo`'s doc comment states this
    plainly: use the bootstrap URL, `apply` will always work, `matches`
    never will, and that's an accepted, documented trade — not a bug to
    chase.
  - Re-adding an already-registered remote without `--if-not-exists` exits 1
    (`error: Remote flathub already exists`); with it, exit 0 regardless —
    confirmed, not assumed, which is what makes `apply`'s perpetual
    non-convergence (above) merely cosmetic rather than destructive.
  - `props.repo` is `"<name> <location>"`, one opaque string split on the
    first space — the same "one string, backend owns its own namespace"
    precedent `dnf`'s COPR shorthand and `apt`'s `ppa:` prefix already set,
    not a new pattern.
- **`snap`** (`backends/linux/Snap.ts`) — **verified, overturning the earlier
  "needs systemd, so a container is not enough" excuse.** That excuse was
  true of a bare `docker run` (`apt-get install snapd` inside a plain
  `ubuntu:24.04` really did time out repeatedly before `snap version` ever
  returned, in an earlier session) but not of containers in general: a
  privileged, systemd-booted container reaches `snapd` the same way it
  already reached `systemd --user` for `system-services`' `systemd-user`
  backend. Recipe: `docker run -d ubuntu:24.04 sleep infinity`, install
  `systemd systemd-sysv dbus-user-session snapd` inside it, `docker commit`
  that into an image, then `docker run -d --privileged --cgroupns=host -v
  /sys/fs/cgroup:/sys/fs/cgroup:rw <image> /sbin/init`. `systemctl
  is-system-running` printed `running` and `ps -p 1` showed a real `systemd`
  process.

  `snap install hello-world` (as root, no `sudo` needed in the container)
  triggered snapd's genuine first-install bootstrap — pulling the `snapd`
  and `core` base snaps, restarting the daemon mid-install ("Requested
  daemon restart (snapd snap)"), then completing all three installs — and
  the installed snap actually ran (`snap run hello-world` → `Hello World!`).
  `snap list` on the empty state prints **nothing on stdout**; the
  human-facing "No snaps are installed yet." message is on **stderr**,
  confirmed by redirecting the two streams separately — so `parseSnapList`'s
  empty-input guard was already handling the right case. The populated
  listing (fixture: `test/fixtures/snap-list.txt`) matched the
  widely-documented header-plus-rows shape exactly:
  ```
  Name         Version             Rev    Tracking       Publisher    Notes
  core         16-2.61.4-20260225  17290  latest/stable  canonical**  core
  hello-world  6.4                 29     latest/stable  canonical**  -
  snapd        2.76.2              27709  latest/stable  canonical**  snapd
  ```
  One previously-undocumented detail: `Publisher` can carry a trailing `**`
  (Canonical's verified-publisher marker) glued directly onto the name with
  no space, and `Notes` reads `-` rather than being blank when there's
  nothing to report — neither affects `firstTokens`, which only reads the
  first column, but both are now confirmed shape rather than assumption.
  Containers and images used for this were removed after capturing the
  fixture (`docker stop`/`rm`/`rmi`), nothing was left running.

## Winget (`src/backends/windows/Winget.ts`)

No Windows/`winget` install is available in this development environment, so
install behavior remains explicitly unverified. The inventory path is now
grounded in the real export schema and captured output:

- [`winget export`](https://learn.microsoft.com/en-us/windows/package-manager/winget/export)
  with `--output <temp-file> --include-versions --accept-source-agreements
  --disable-interactivity` is the documented machine-readable export surface.
  The backend allocates the file through the generic package-list context,
  reads it with Effect's filesystem service, and deletes its temp directory
  after every listing.
- The export JSON nests entries under `Sources[].Packages[]`; each entry's
  `PackageIdentifier` and optional `Version` are schema-decoded. Unknown
  metadata is ignored, and malformed output fails as `BackendParseError` rather
  than becoming an empty inventory.
- `winget list` remains parsed only for the captured-output regression test.
  Its fixed-width ellipsis behavior is not safe as the production inventory,
  because a truncated identifier is unrecoverable.
- `winget install --id <id> --exact --accept-package-agreements
  --accept-source-agreements --silent --disable-interactivity` — the
  documented combination for a non-interactive install. `--exact` remains
  deliberate, but the command itself still needs a real Windows verification.

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

## The six language backends, in containers (`src/backends/language/*.ts`)

All six had already been checked against a real local install on this
machine (see "New package-manager backends" above), but none of that had
ever produced a committed fixture or run anywhere but this one Mac. This
session ran every one of them again inside Docker — `rust:latest`,
`node:22`, `python:3.12`, `ruby:3.3`, `golang:1.23` — installed a real
package with each manager, and captured the actual `list` output as a
fixture under `test/fixtures/`, pinned by `test/languageBackends.test.ts`.

**All six parsers matched on the first try — no code changes.** Specifics
worth recording:

- **`cargo`** — a fresh `rust:latest` printed nothing for `cargo install
  --list`; after `cargo install just --locked` then `cargo install ripgrep
  --locked`, it printed two unindented `<crate> v<version>:` headers each
  followed by one indented binary line, exactly as documented.
- **`npm`** — `node:22`'s `npm ls -g --depth=0 --json` came back with an
  extra top-level `"name": "lib"` key this container's npm added that the
  local capture hadn't shown; `NpmLs`'s `Schema.Struct` ignoring excess
  properties by default is exactly what kept this from being a parse
  failure — a real, if narrowly-averted, confirmation of that design choice.
- **`pipx`/`uv-tool`** — `python:3.12` gave the first real *multi-package*
  listings for both (previously only ever verified with one installed
  package apiece): `pipx list --short` after installing `cowsay` and
  `yt-dlp` printed both on separate two-token lines; `uv tool list` printed
  two full header-plus-sub-line pairs back to back, confirming the `v\d`
  header regex doesn't false-match a second tool's own `- <bin>` line.
- **`gem`** — `ruby:3.3` (Ruby 3.3.12, gem 3.5.22) is a different Ruby
  entirely from this machine's SIP-protected system Ruby 2.6.10, and parsed
  identically: a pre-existing `rake (13.1.0)` plus two more pinned installs
  collapsed into one `rake (13.4.2, 13.1.0, 13.0.6)` line, alongside a new
  `cowsay (0.3.0)` line.
- **`go-install`** — `golang:1.23` (go1.23.12) reproduced the documented
  empty-directory case exactly (`go version -m dir/*` fails on the literal
  `*`, `2>/dev/null; true` swallows it, `list` sees empty stdout) and, after
  installing two binaries, printed both build-info blocks back to back with
  `parseGoVersionM` correctly pulling just the two import paths out. It also
  surfaced a real but incidental finding: `go install ...@latest` failed
  outright against go1.23.12 with `golang.org/x/tools@v0.49.0 requires go >=
  1.25.0` — a dependency's own version floor, unrelated to this backend's
  parsing, and worth knowing about if this ever runs on a machine with an
  older Go. Installing pinned `@v0.21.0` builds of the same two tools worked
  and is what the committed fixture reflects.

All six are `✓` in [MAP.md](../MAP.md) as of this session.

One thing this session broke and fixed, unrelated to any backend: this
sandbox's `docker run --platform linux/amd64` emulation started failing
outright (`exec ...: exec format error`, even for `echo` in a fresh `alpine`
container) partway through, for reasons unrelated to any pacman transaction
— `docker run --privileged --rm tonistiigi/binfmt --install all` re-registered
the QEMU binfmt handlers and fixed it. Noted here in case a future session
hits the same wall: it is an environment issue, not a finding about any tool
under test.

## `paru` — attempted, still `~` (`src/backends/linux/Aur.ts`)

Two attempts, same `docker run --rm --platform linux/amd64 archlinux:latest`
image `yay`'s own verification used, neither reaching a running `paru` this
session:

**Attempt 1 — `paru-bin`, mirroring exactly what worked for `yay-bin`:**
`pacman -Sy --noconfirm --disable-sandbox sudo base-devel git` (sync only, no
upgrade — the same as the `yay` session), then as a non-root `builder` user
`git clone https://aur.archlinux.org/paru-bin.git && makepkg -si --noconfirm`.
The package built and installed without error. Running it immediately failed:

```
$ paru --version
paru: error while loading shared libraries: libalpm.so.15: cannot open shared object file: No such file or directory
```

This is a real ABI mismatch, not a fluke: `paru-bin` is a precompiled binary
built against whatever `libalpm` version the AUR's own build server had at
build time, and a container that only synced package databases (`pacman -Sy`)
without upgrading installed packages (`pacman -Syu`) can easily have an older
one. `yay-bin`'s successful run in the identical kind of container in the
earlier session did **not** mean every AUR `-bin` package tolerates a
freshly-synced-but-not-upgraded system this well — that was this session's
assumption walking in, and it was wrong.

A `pacman -Syu` before installing would plausibly fix this, but the first
attempt at that combination corrupted this sandbox's own amd64 QEMU emulation
mid-transaction (`exec ...: exec format error` for every subsequent command,
including a bare `echo`, in **any** amd64 container — not just this one).
Re-registering the binfmt handlers (`docker run --privileged --rm
tonistiigi/binfmt --install all`, noted above) fixed the emulation, but
whether it was `pacman -Syu` itself or an unrelated sandbox hiccup that broke
it first was not isolated — the safer path taken afterward was attempt 2.

**Attempt 2 — building plain `paru` from source**, which sidesteps the ABI
question entirely (it links against whatever `libalpm` is actually present,
rather than shipping its own expectation of one): `pacman -Sy --noconfirm
--disable-sandbox sudo base-devel git rust` (no `-Syu`), then `git clone
https://aur.archlinux.org/paru.git && makepkg -si --noconfirm` as `builder`.
This compiled cleanly through paru's entire dependency tree — `alpm`,
`alpm-utils`, `aur-depends`, `aur-fetch`, `raur`, `reqwest`, `scraper`,
`html5ever`, `cssparser`, `tokio`, `chrono`, roughly 140 crates in total, zero
compile errors — and reached the final step: linking the `paru` binary itself
in release mode with full LTO and `codegen-units=1`. That final link was
still actively running (steady 100% CPU, memory climbing past 2.6GB, no
crash) when this session's verification work concluded; it simply did not
finish inside the time available. `codegen-units=1` plus full LTO means the
whole ~140-crate dependency graph gets optimized and linked as one
single-threaded unit — normally a multi-minute cost even natively, and this
sandbox runs amd64 Arch entirely under QEMU emulation on Apple Silicon, which
compounds it further. Nothing about the *build* suggested it would fail; it
was purely a matter of time.

**Net result:** `paru` stays `~` in [MAP.md](../MAP.md) — the `-S`/`-Qmq`
behavioural checks `yay`'s section already has were never reached — but this
is no longer the same `~` as before. The `paru-bin` ABI-mismatch finding is
real and worth remembering the next time an AUR `-bin` package is verified in
a freshly-synced container, and the from-source path is now known to compile
cleanly; a session with either more time or a faster (non-emulated) amd64
host can pick the same container recipe back up and just wait out the final
link.
