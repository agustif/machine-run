# Runtime backend verification notes

What was verified by running the real CLI, where, and what remains
unverified — for `@machine-run/runtimes` (`RuntimeBackend` + `Runtime.Tool`).
See `packages/runtimes/TASKS.md` for the resulting backlog.

Tool versions verified against: `mise 2026.7.18` (this machine, macOS,
Homebrew install), `rustup 1.29.0` / `rustc 1.97.1` (this machine), `uv 0.12.2`
(this machine), `asdf 0.20.0` (Linux `ubuntu:24.04` container — not installed
on this machine).

## mise

Verified directly on this machine, including inside throwaway `$HOME`
directories so nothing here touched the real `~/.config/mise`:

- `mise ls <tool> --json` returns a bare array (not the object `mise ls --json`
  with no tool argument returns), each entry carrying `installed` and `active`
  together.
- `active` is resolved with respect to the process's cwd — the same tool
  reports a different entry active depending on whether a local `mise.toml`
  is in scope. `Runtime.Tool`'s `observe` always sets `cwd` explicitly for
  this reason.
- `mise use --global --pin -y <tool>@<version>` writes the *exact resolved*
  version into `~/.config/mise/config.toml`'s `[tools]` table; `mise use --pin
  -y` (no `--global`, run with `cwd` set) does the identical thing into
  `<cwd>/mise.toml`, creating the file if none exists there yet.
- `MISE_GLOBAL_CONFIG_FILE` is a real, documented override (`mise use --help`)
  for relocating the global config path.
- No confirmation prompt was hit installing a brand-new tool/version inside a
  throwaway `$HOME`, with or without `-y`. `-y` is kept anyway since Alchemy's
  `CommandExecutor` runs non-interactively (`stdin: "ignore"`), and any prompt
  under that would hang rather than fail visibly.

**Not verified:** `MISE_GLOBAL_CONFIG_FILE` pointed at a path outside
`$HOME`'s tree, and mise on Linux/Windows.

## rustup

Verified directly on this machine (real `~/.rustup/settings.toml`, restored
to its original contents — no override left behind — after each check):

- `rustup show` in one call gives the default host triple, the full
  installed-toolchain list (each optionally annotated `(active)` / `(default)`
  / `(active, default)`), and an unambiguous `active toolchain` section naming
  exactly one toolchain by its `name:` line.
- Toolchain names for the default host are always `<channel-or-version>-<host
  triple>` (e.g. `stable-aarch64-apple-darwin`). The backend strips that
  suffix so a plain request (`"stable"`, `"1.75.0"`) compares against what
  `rustup` actually lists.
- `rustup override set`/`unset` write into `[overrides]` in the *same*
  `~/.rustup/settings.toml` that holds `default_toolchain` — verified by
  setting a directory override and reading the file directly. This is why
  `Rustup.ts`'s `configPath` ignores `scope` entirely, unlike mise/asdf/uv.
- `RUSTUP_HOME` is a real override, verified directly
  (`RUSTUP_HOME=<dir> rustup show` reports that dir back as "rustup home").
- `rustup toolchain list` marks `(active)` on the override's toolchain, not
  the default's, when run with `cwd` inside an overridden directory —
  verified directly.

**Not verified:** what `rustup show` prints when *no* toolchain is active at
all (no default ever set, no override) — this machine has always had a
default. `parseRustupShow` returns `active: undefined` in that case by
construction (the regex simply fails to match), but that specific output
shape was not produced and read. Also not verified: a cross-compiled
toolchain (installed for a non-default host) — the host-suffix strip only
applies to the *default* host's suffix, by design (see `Rustup.ts`'s doc
comment), so such a toolchain's full triple-qualified name would need to be
spelled out in full by a recipe; this was reasoned, not exercised.

## asdf

**Not installed on this machine** (`asdf: command not found` — verified by
checking, not assumed). Verified in an `ubuntu:24.04` Docker container by
downloading the real `v0.20.0` linux-arm64 release binary and running it —
never `docker ps`/prune/kill against anything else running on the host, only
`docker run --rm` per check.

- `asdf global`/`asdf local` from older asdf **do not exist in 0.20.0** —
  confirmed by trying `asdf global nodejs 22.11.0` and getting `invalid
  command provided: global`. The current interface is `asdf set [-u|-p]
  <tool> <version>`: no flag targets the nearest `.tool-versions` (creating one
  in cwd if none exists), `-u`/`--home` targets `$HOME`'s file regardless of
  cwd, `-p`/`--parent` searches upward instead of writing in cwd. This is a
  real, current-version fact worth restating because plenty of asdf
  documentation online still describes `global`/`local`.
- `asdf current <tool>` prints its informative row (including the `______`
  sentinel for "unset") to **stdout**, but exits non-zero (`126` unset, `1`
  pinned-but-not-installed) whenever there's nothing fully resolved — verified
  by separating stdout/stderr with redirection. Alchemy's `CommandExecutor`
  converts a non-zero exit into a `CommandError` carrying only `stderr`
  (empty here), discarding stdout entirely — so this command cannot be parsed
  through `Exec` at all in the cases that matter most. `Asdf.ts` uses `asdf
  list <tool>` instead, whose leading-`*` marker gives the identical
  information and always exits 0 (verified for: plugin missing → exit 1
  before ever calling `list`, avoided by checking `asdf plugin list` first;
  plugin present, zero versions → exit 0, message text; one version
  installed+active → exit 0, `*`-marked).
- `asdf plugin add <tool>` is idempotent — exit 0 both on a fresh add and on
  an already-added plugin (different stdout text, same exit code) — verified
  directly.
- `asdf plugin list` never fails: `No plugins installed` (exit 0) when empty,
  one name per line (exit 0) otherwise. This is what `observe` uses to decide
  whether it's safe to call `asdf list <tool>` at all, without ever adding a
  plugin itself (a real side effect — a git clone — that `observe` must not
  perform).
- `ASDF_TOOL_VERSIONS_FILENAME` is real (`asdf info`'s "ASDF INTERNAL
  VARIABLES" section). No variable relocates *where* the global file lives;
  it always resolves against `$HOME`.

**Not verified:** asdf on macOS or native Linux (only the Ubuntu container),
and asdf's Windows story (asdf itself does not support Windows natively).

## uv

Verified directly on this machine, using a throwaway `$HOME` for every write
so nothing here touched the real `~/.config/uv`:

- `uv python list --only-installed --output-format json` reports one entry
  per *path* that resolves to an interpreter, so the same version can appear
  more than once (a versioned binary and a `python3` symlink pointing at it).
  `Uv.ts` de-duplicates by `version`.
- There is no "active" flag anywhere in that listing, and no subcommand that
  answers "what's pinned at path P" directly — `uv python find` resolves to
  an interpreter *path*, not a version. `observe` reads the pin file `uv
  python pin` itself writes, directly, with `FileSystem` — verified: `uv
  python pin --global 3.12` writes the literal text `3.12` (the request, not
  a resolved patch version) to `$HOME/.config/uv/.python-version`; `uv python
  pin 3.12` (no `--global`, run with `cwd` set) writes the same text to
  `<cwd>/.python-version`.
- uv resolves its config directory as `$HOME/.config` on macOS by default
  (not `~/Library/Application Support`) — verified directly by pinning with a
  substitute `$HOME` and no `XDG_CONFIG_HOME` set.
- `uv python pin --global <version>` downloads a matching interpreter itself
  if none is installed yet — observed as a side effect of testing the pin
  behavior, not something `Runtime.Tool` relies on (`install`/`activate`
  stay separate calls here, like every other backend).

**Not verified:** `XDG_CONFIG_HOME` actually set to something other than the
default — `Uv.ts` honors it as a reasonable extension of the verified
default, not as an independently-checked flag. uv on Linux/Windows.

## What `Runtime.Tool` still does not do

- **No manifest layer.** `mise.toml`/`.tool-versions`/`uv`'s
  `pyproject.toml` are real, first-class ecosystem files with their own
  idempotent apply (`mise install` against a checked-in `mise.toml`, for
  instance) — the "manifest" layer `docs/V1-PLAN.md` §3 describes as
  complementary to this atomic one. `Runtime.Tool` only ever manages one
  tool's one entry through each manager's own CLI; it does not read or write
  a whole manifest file, and does not detect or refuse the conflict a
  `Runtime.Manifest`-shaped resource sharing a file with it would create.
  That resource is not built here — the boundary suggested by this pass:
  `Runtime.Tool` for "this exact version, converged and drift-detected import
  by import"; a future manifest resource for "this checked-in file, applied
  wholesale, imported from an existing project" — mirroring `System.Package`
  vs. `Brew.Bundle`.
- **No `nvm`/`pyenv`.** The brief asked for one of `uv`/`pyenv`; `uv` was
  picked (already installed here, and both `pip`/`venv` and Python-version
  management in one tool). `pyenv` and `nvm` are not implemented, and adding
  either follows the same `RuntimeBackend` seam.
- **No caching across `observe` calls.** `system-packages`'s `PackageIndex`
  memoizes one listing per manager per plan/apply phase, because a package
  listing answers one shared question for every declared package on that
  manager. A runtime's `observe` already answers a narrower, per-`(tool,
  scope)` question in one call, so the identical N-per-resource cost
  `PackageIndex` exists to fix does not obviously apply the same way here —
  but multiple `Runtime.Tool` resources for the *same* `(manager, tool, scope)`
  (unusual, but not prevented) would still re-shell redundantly. Not built;
  noted as a real gap if that shape ever comes up.
