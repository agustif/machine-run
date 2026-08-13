# Architecture

This document describes how machine-run is actually built today. For the
*why* behind these choices, see [DESIGN.md](./DESIGN.md). For Alchemy's own
engine-level doctrine (which this document applies rather than restates), see
Alchemy's `AGENTS.md` — during dogfooding that's
`/Users/a/alchimist/alchemy/AGENTS.md` on the author's machine; once Alchemy
is public it's `AGENTS.md` at the root of the `alchemy` package/repo
(alchemy.run).

## The Resource / Provider / Layer model, as applied here

Every custom resource in machine-run follows Alchemy's standard shape: a
`Resource<Type, Props, Attributes>` interface plus a `Provider` built with
`Provider.effect(ResourceTag, Effect.gen(...))`, returning
`ResourceTag.Provider.of({ list, diff, reconcile, delete })`. None of
machine-run's resources declare a fourth (Binding Contract) type parameter —
that mechanism exists in Alchemy for wiring runtime capabilities into deployed
Functions/Workers, which has no analogue for a personal machine.

Concretely, every resource file (`File.ts`, `ManagedBlock.ts`, `Symlink.ts`,
`SecretFile.ts`, `Default.ts`, `Connection.ts`, `Package.ts`, `Repo.ts`)
co-locates:

1. The `*Props` input interface.
2. The `Resource<"...", Props, Attrs>` interface + `export const X = Resource<X>("...")`.
3. A `*Provider = () => Provider.effect(X, Effect.gen(function* () { ... }))`
   factory that resolves its Effect dependencies (`CommandExecutor`, other
   services) once, then returns the `list`/`diff`/`reconcile`/`delete` object.

This matches Alchemy's own file-system convention of co-locating a resource's
contract and its provider in one file, one resource per file.

### Reconciler doctrine, applied at machine-run's scale

Alchemy's reconciler doctrine calls for one observe → ensure → sync → return
flow that works uniformly across greenfield-create, routine-update, and
adoption, and explicitly bans branching the whole reconcile body on
`output === undefined`. machine-run's resources are almost all simple enough
that there's no multi-aspect "sync" step — they fall into the doctrine's own
"existence-only" category:

- **`System.Package`, `System.Repo`, `Machine.SecretFile`,
  `Tailscale.Connection`** — reconcile is `list installed → if missing,
  install`. There is nothing else mutable about "is this package installed."
- **`Machine.File`, `Machine.ManagedBlock`** — one mutable aspect (content),
  diffed via a SHA-256 hash of desired content compared against the hash
  recorded in `output`. Whole-content overwrite on any hash mismatch, not an
  incremental patch.
- **`Machine.Symlink`** — genuinely observes live state (`fs.readLink`) rather
  than trusting `output`, matching the doctrine's "observation > assumption"
  principle exactly: it re-reads the actual symlink target on every
  diff/reconcile, so a target changed outside machine-run (or never created
  yet) is detected correctly.
- **`MacOS.Default`** — the one deliberate, documented exception. It diffs
  against its own last-recorded `output.value`, not a live `defaults read`.
  See DESIGN.md for why this was chosen and what it trades away.

The one place machine-run *does* branch on `output === undefined` is a
narrow, single side effect — not the reconcile body's control flow: `Machine
.File`/`ManagedBlock`/`Symlink`/... call `backupIfExists` only `if (!output)`,
to snapshot real pre-existing content exactly once, on a resource's first-ever
reconcile. See DESIGN.md for why this is not the anti-pattern the doctrine
warns against.

Every resource's `delete` is `() => Effect.void`. This is a repo-wide,
deliberate invariant: `alchemy destroy` never uninstalls a package, never
removes a managed block or symlink, never deletes a materialized secret file,
never reverts a macOS default, and never runs `tailscale down`. Dotfiles and
installed software outlive any given machine-run stack; only Alchemy's own
bookkeeping (state) is what `destroy` clears. This mirrors Alchemy's own
`Command.Exec`, whose side effects are likewise never reversed on delete.

### Typed-error doctrine, applied here

There's no generated SDK to JSON-patch in machine-run (no `distilled`
equivalent) — errors come from parsing CLI stdout/stderr, so the doctrine is
applied by hand-authoring `Data.TaggedError` classes at the boundary instead
of ever letting an `unknown` or string-matched error escape into caller code:

- `SymlinkSourceMissing` (`dotfiles/src/Symlink.ts`) — a real, typed failure
  when a symlink's `source` doesn't exist, rather than fabricating an empty
  placeholder.
- `OnePasswordCliMissing` / `OnePasswordAuthRequired` / `OnePasswordReadFailed`
  (`secrets/src/OnePassword.ts`) — a `classifyFailure` helper buckets the raw
  `CommandError`'s message text (`"command not found"`, `"not signed in"`,
  etc.) into one of these three tags before it ever reaches a caller.
- `DopplerRunFailed` (`secrets/src/Doppler.ts`) — currently a single
  catch-all tag with no further classification (see TASKS.md).
- `BackendParseError` (`system-packages/src/Backend.ts`) — raised when a
  backend's `Effect.try` around `JSON.parse` fails (used by the npm backend).

Callers use `Effect.catchTag`, never `_tag === "..."` duck-typed predicates
on `unknown`.

### Effect platform services, not raw Node APIs

Resource and helper code uses `FileSystem.FileSystem` / `Path.Path` (never
`node:fs`/`node:path` directly) and `CommandExecutor` from `alchemy/Command`
(never raw `child_process`). The one intentional exception is
`core/src/hash.ts`'s `sha256`, which wraps `crypto.subtle.digest` (a
genuinely-async Web Crypto API with no Effect-native equivalent) in
`Effect.promise` rather than `Effect.sync` — the same approach the file's own
comment says alchemy's own `Util/sha256.ts` uses.

## Package dependency graph

```
@machine-run/core
  └── @machine-run/dotfiles
        ├── @machine-run/git-identity
        ├── @machine-run/ssh
        └── @machine-run/ai-tools

@machine-run/secrets
  └── @machine-run/tailscale

@machine-run/macos-defaults      (standalone — only peers on alchemy/effect)
@machine-run/system-packages     (standalone — only peers on alchemy/effect)
```

- **`core`** has no resources — just `backupIfExists` (used by every dotfiles
  resource) and `sha256` (used by `File`/`ManagedBlock` for content hashing).
- **`dotfiles`** depends on `core` and defines the three resources
  (`Machine.File`, `Machine.ManagedBlock`, `Machine.Symlink`) that
  `git-identity`, `ssh`, and `ai-tools` all compose on top of. None of those
  three downstream packages define a resource of their own — they're plain
  `Effect.gen` functions (`gitIdentity()`, `sshHost()`, `aiTools()`) that
  `yield*` `Dotfiles.File`/`ManagedBlock`/`Symlink` calls. This is why they
  have no `Providers.ts` of their own.
- **`secrets`** defines `Machine.SecretFile` and the two live secret-source
  services (`OnePassword`, `Doppler`); it does not depend on `dotfiles` or
  `core` — `SecretFile` never calls `backupIfExists` (nothing pre-existing to
  snapshot; a secret file is either present or not) and never hashes content
  (see below).
- **`tailscale`** depends on `secrets` because `Tailscale.Connection` reads
  its auth key via `OnePassword`.
- **`macos-defaults`** and **`system-packages`** each only need
  `CommandExecutor` from Alchemy directly — no dependency on any other
  machine-run package.

Each package provides its own `providers()` `Layer` (e.g.
`secrets/src/Providers.ts`) that supplies its own dependencies
(`OnePasswordLive()`, `CommandExecutorLive()`) internally, so it resolves on
its own regardless of whether the app-level stack composition also happens to
provide overlapping layers elsewhere.

## The system-packages backend abstraction — the canonical "add a new provider" pattern

`@machine-run/system-packages` is the reference example for "how do I support
a new provider" anywhere in machine-run:

- **`Backend.ts`** declares the one shared interface,
  `PackageManagerBackend`: `id`, `list(session)`, `install(name, session)`,
  and optional `listRepos(session)`/`addRepo(repo, session)`.
- **`backends/*.ts`** — seven files, one per package manager family
  (`Apt.ts`, `Brew.ts`, `Cargo.ts`, `Dnf.ts`, `MacPorts.ts`, `Npm.ts`,
  `Pacman.ts`), each exporting a `make*Backend(executor)` factory that
  implements the interface by shelling out via `CommandExecutor` and parsing
  that tool's real output format (`dpkg-query`'s `-f` format string,
  `cargo install --list`'s indented-binaries format, `npm ls -g --json`'s
  `dependencies` object, `port installed`'s table). `Brew.ts` contributes
  *two* backends from one file — `makeBrewBackend` (`brew`) and
  `makeBrewCaskBackend` (`brew-cask`) — since both shell out to the same
  `brew` CLI with different subcommands.
- **`Package.ts`** and **`Repo.ts`** are the two generic, atomic resources.
  They know nothing about any specific package manager — their provider
  builds a `Record<PackageManagerId, PackageManagerBackend>` map once, and
  `reconcile` just looks up `backends[news.manager]` and calls `.list()` /
  `.install()`. `Repo`'s manager set (`RepoManagerId = "brew" | "apt"`) is
  narrower than `Package`'s eight IDs, because only brew (taps) and apt
  (PPAs) have a real "extra repository" concept wired up so far — dnf/pacman
  repo support is unresearched (see TASKS.md).
- **`detect.ts`** picks a sensible default `PackageManagerId` from
  `process.platform` and a couple of `FileSystem.exists` checks
  (`/etc/debian_version`, `/etc/redhat-release`, `/etc/arch-release`) — no
  `CommandExecutor` or live session needed, so a recipe can call it at
  composition time before any resource is even constructed.
- **`bulk.ts`** is pure sugar: `packages(manager, names)` and
  `repos(manager, values)` loop over a name/value list and `yield*` one
  `Package`/`Repo` resource per entry (with a filesystem-safe logical ID
  derived from the raw name). This is *not* a bundle resource — the engine
  still sees N independent, independently-diffed resources; the loop just
  saves writing it out at every call site.

**Adding a new package manager backend means writing one new
`make*Backend(executor)` module implementing `PackageManagerBackend`,
registering it in `Package.ts`'s (and optionally `Repo.ts`'s) backend map,
and adding its id to `PackageManagerId` — never touching `Package`/`Repo`'s
resource contract or reconcile logic itself.** The same shape should be
followed for any other family of pluggable, CLI-shaped providers this
project grows (more secret backends, more AI-tool integrations): one shared
interface, one small file per implementation, dispatched by a lookup inside
one generic resource — never a new resource type per backend.

## Secrets never enter Alchemy's local state

Alchemy's local state store (`Alchemy.localState()`) is unencrypted JSON,
intended to be committed to a private git repo alongside a recipe. That's
fine for "this file exists at this path" but never fine for the file's
*contents*. Concretely:

- `Machine.SecretFile`'s `diff` only calls `fs.exists(news.path)` — it never
  hashes or otherwise reads `news` content into a comparison, and its
  `Attributes` shape is `{ path: string }` only. There is no code path by
  which a secret's bytes (or a hash of them) could be written into state.
- `OnePassword` (`secrets/src/OnePassword.ts`) and `Doppler`
  (`secrets/src/Doppler.ts`) are both modeled as **live** services (Effect
  `Context.Service`s backed by a `Layer.effect` that shells out via
  `CommandExecutor`) rather than resources. Nothing about either service's
  output is ever persisted — `OnePassword.read` returns a `string` used
  immediately to write a file or feed a command; `Doppler.run` executes a
  command with injected env vars and returns its stdout/stderr, never the
  secret values that were injected.
- The two backends address different needs: 1Password materializes
  individual credential *files* on disk (for things a process needs to find
  at a path, like an SSH key); Doppler injects environment variables into a
  single command invocation (for secrets meant to be read from
  `process.env`, never written to disk at all).
- Neither backend automates authentication — `OnePasswordAuthRequired`'s
  message says so explicitly: "Run `op signin` yourself — machine-run
  deliberately never automates authentication."

## The machine-run / machines-`<you>` split

machine-run is meant to be public and generic; it carries no one's actual
name, email, SSH hosts, package list, or secret references. Those live in a
separate, private repo per person (the author's is `machines-agusti`,
github.com/agustif/machines-agusti) that depends on machine-run's packages
the way any consumer would. During dogfooding, `machines-agusti` points at
this repo via a local `file:`-style workspace dependency rather than a real
npm version, so both repos can be developed together without publishing
half-finished framework code. See BLUEPRINT.md for what has to be true before
that becomes a real npm dependency.
