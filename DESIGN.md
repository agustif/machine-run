# Design decisions

A log of real tradeoffs already made in this codebase, and why. Not a wishlist
— every decision here is reflected in the current source. See
[ARCHITECTURE.md](./ARCHITECTURE.md) for how these decisions shook out
structurally, and [TASKS.md](./TASKS.md) for what's still open.

## Atomic resources, not bundles — the god-provider correction

The very first commit (`21b57d3`, "Initial machine-run: Alchemy+Effect
personal machine reconciler") shipped a Homebrew-bundle-shaped design:
resources that owned a whole list of packages/casks/taps at once. The very
next real refactor (`2e5c0c8`, "Refactor to atomic system-packages, split
personal impl, add tests") explicitly reversed this:

> Replace the god-shaped Homebrew-bundle/Cargo/Npm bundle resources with
> `@machine-run/system-packages`: one atomic `Machine.Package` /
> `Machine.Repo` resource per package/repo, dispatched to a pluggable backend
> (brew, brew-cask, port, apt, dnf, pacman, cargo, npm) — matching how
> alchemy's own resources are always one entity each, never a resource that
> owns a whole list.

The problem with the bundle shape wasn't cosmetic: a resource that owns "all
your packages" can't diff or reconcile any single package independently, it
conflates the identity of N unrelated real-world objects into one Alchemy
logical ID, and a partial failure mid-bundle has no clean atomic-resource
story (which one is the resource "in"?). Every resource in machine-run today
is atomic: one file, one managed block, one symlink, one installed package,
one extra repo, one materialized secret file, one macOS default, one
Tailscale connection.

## Why not a generic cross-package-manager resource?

A naive reading of "abstract shared components, support multiple providers"
might suggest one truly generic `Package` resource type that hides brew vs.
apt vs. cargo behind a single opaque interface with no `manager` field at
all. machine-run doesn't do that, and the reasoning follows Alchemy's own
precedent rather than inventing a new one: **Alchemy itself has no
generic cross-cloud resource.** There's no `Storage.Bucket` that abstracts
over `AWS.S3.Bucket` and `Cloudflare.R2.Bucket` — every one of Alchemy's
resources is provider-specific and atomic. `System.Package` follows the same
shape one level down: it's one generic *resource type*, but `manager` is an
explicit, required prop, and the actual provider-specific behavior lives
entirely in the `PackageManagerBackend` implementations it dispatches to
(`system-packages/src/backends/*.ts`). The abstraction lives at the backend
layer, not by pretending "install ripgrep" means the same thing on every OS
regardless of which tool does it.

## Node.js + npm is the default runtime, not bun

The initial design (`21b57d3`'s `package.json`) used a bun-only workspace
(`"packageManager": "bun@1.3.14"`, `types: ["bun"]`, `bun run --filter`
scripts). The refactor commit flipped this:

> Flipped the default runtime story to Node/npm, with bun/deno as explicit
> opt-ins (`bootstrap.sh --bun` / `--deno`).

`bootstrap.sh` now defaults to Node + npm and only switches to bun or deno
when explicitly passed `--bun`/`--deno`; it also says outright that
`"deno support is opt-in and unverified — machine-run's own packages are only
tested under node/bun so far."` This is a deliberate accessibility choice
ahead of public release: Node + npm is the lowest-common-denominator runtime
almost anyone with a machine already has (or that any OS's own package
manager can install trivially), whereas requiring bun specifically is one
more unusual dependency for a stranger to accept before they can even try the
framework. `tsconfig.base.json` still lists `"types": ["bun"]` — a leftover
from the bun-only era that hasn't been revisited (see TASKS.md).

## Dropping `alchemy-test` for `@effect/vitest`

The initial commit depended on `alchemy-test` via a local
`file:/Users/a/alchimist/alchemy/packages/alchemy-test` reference — Alchemy's
own private, unpublished, single-process Effect-native test runner, pinned to
the exact git tag matching the published `alchemy@2.0.0-beta.67`. It turned
out to be broken in that exact pinned state — a `queueMicrotask` /
`AsyncLocalStorage` interaction — with no fix available short of upstream
Alchemy stabilizing its own test harness. The refactor commit dropped it in
favor of `@effect/vitest`, a real, published, stable package, and rewrote the
existing tests around it.

This has a real consequence, stated plainly rather than glossed over: **there
is currently no way to run a full Alchemy Resource/Provider lifecycle test
against machine-run's resources** — nothing exercises `diff`/`reconcile`
through the actual engine end-to-end (deploy, then re-deploy, and assert the
right no-op/update/replace happened). What the current tests cover instead:

- **Pure logic** — e.g. `dotfiles/test/ManagedBlock.test.ts`'s tests of
  `renderFile` as a plain string-in/string-out function, no Effect or
  Alchemy involved at all.
- **Effect-based logic against a real filesystem** — via
  `@effect/platform-node`'s `NodeContext.layer`, e.g.
  `core/test/backup.test.ts` (`backupIfExists` against real temp
  directories) and `core/test/hash.test.ts` (`sha256`).
- **Package-manager backend logic** — via fake `CommandExecutor` objects
  (`system-packages/test/backends.test.ts`) that return canned stdout,
  proving each backend's output-parsing and command-shape logic without a
  real shell.

This is an honest, known limitation, not a solved problem: full
resource-lifecycle integration testing is blocked on `alchemy-test`
stabilizing (or on writing an alternative harness of machine-run's own).
Separately — and this is a real bug in the current tree, not a design
choice — the migration away from `alchemy-test` was incomplete:
`dotfiles/test/File.test.ts` and `dotfiles/test/Symlink.test.ts` still import
from `"alchemy-test"` and `"alchemy/Test/Alchemy"`, which are no longer
listed as project dependencies at all (removed from `package.json` in the
same commit that migrated `ManagedBlock.test.ts`). See TASKS.md.

## Backup-before-first-write, gated on `output === undefined`

Every dotfiles resource (`Machine.File`, `Machine.ManagedBlock`,
`Machine.Symlink`) calls `backupIfExists(target, ".machine-run-backups")`
inside `reconcile`, but only `if (!output)` — i.e. only on the resource's
first-ever successful reconcile, when there is no prior recorded output at
all. Two things make this the right gate, not the "rename-and-branch"
anti-pattern the reconciler doctrine warns against:

1. **It's a single, narrow side effect, not the reconcile body's control
   flow.** The doctrine's warning is against writing
   `if (output === undefined) { /* create body */ } else { /* update body
   */ }` — two entirely different code paths for the same resource. Here,
   the rest of `reconcile` (make the directory, write/symlink the content,
   compute the returned hash) is identical regardless of `output`; only one
   `yield*` is conditional.
2. **It would be actively wrong to run unconditionally.** If
   `backupIfExists` ran on every apply, it would keep re-snapshotting
   machine-run's *own* previously-generated content into a new timestamped
   directory every single time you run `deploy` — an ever-growing pile of
   backups of nothing anyone needs, since after the first reconcile the file
   only ever contains what machine-run itself wrote. Gating on `!output`
   captures exactly the one moment that matters: the transition from "no
   Alchemy-managed state for this resource" to "managed" — which is the only
   point in time a real, pre-existing, hand-written file could plausibly
   still be sitting at that path.

## `MacOS.Default` diffs against its own output, not live `defaults read`

Every other resource that observes existing state does so live (`Symlink`
re-reads the real `fs.readLink` target every time; `Package`/`Repo` call the
backend's `list()` every time). `MacOS.Default` is the one deliberate
exception: its `diff` compares `news.value` against `output.value` — the
value it last wrote — rather than shelling out to `defaults read` to observe
the live system value. The source comment is explicit about this being a
conscious optimization, not an oversight: "a deliberate, cheap optimization
(like alchemy's own `Command.Exec` memoization) since nothing but machine-run
is expected to touch these keys once managed." The tradeoff: if something
else (System Settings.app, another script, a macOS update resetting a
default) changes a managed key outside machine-run, this resource won't
notice or self-heal on the next `deploy` — it will report no change when the
live system in fact drifted. That's an accepted, documented risk, not a bug;
revisiting it (e.g. behind an opt-in "verify live state" flag) is on the
backlog.

## Secrets never enter state, ever

`Machine.SecretFile`'s `diff` checks file existence only —
`fs.exists(news.path)` — never content, never a hash of content. This isn't
merely "for now"; it's structural: Alchemy's local state file is unencrypted
JSON meant to be committed to a private git repo, and there is no code path
in `SecretFile` by which the secret's actual bytes could reach that JSON.
`OnePassword` and `Doppler` are both live secret-source *services*
(Effect `Context.Service`s), never resources whose attributes could be
persisted — see ARCHITECTURE.md for the read/env-injection distinction
between them.

## Symlink refuses to auto-adopt

`Machine.Symlink` fails clearly (`SymlinkSourceMissing`) rather than
fabricating an empty placeholder when its `source` doesn't exist. The
docs comment on `SymlinkProps` states the reasoning: "Bringing a real config
under management is a deliberate, reviewed step (copy it into the repo
yourself) — never an automatic one, since these directories can also contain
credentials that must never be copied into a git repo unreviewed." This is
why `@machine-run/ai-tools`'s `aiTools()` only ever symlinks a hand-picked,
explicitly-reviewed allowlist of paths (`AI_TOOL_SKILLS_DIRS`,
`AI_TOOL_CONFIG_FILES`) and never a tool's entire config directory — it
deliberately never touches `auth.json`, anything matching
`*session*`/`*token*`/`*credential*`, `*.db`/`*.sqlite*`, `logs`, `cache`,
`*.lock`, or `history.jsonl`.

## `packages()`/`repos()` bulk sugar is not a bundle resource

`system-packages/src/bulk.ts` exports `packages(manager, names)` and
`repos(manager, values)`, which loop over a list and `yield*` one resource
per entry. This might look like it contradicts the no-bundles principle, but
it doesn't: the loop happens at *recipe composition time*, before Alchemy
ever sees a resource graph. Alchemy's engine still sees N independent
`System.Package`/`System.Repo` resources, each with its own logical ID
(derived from the manager + a filesystem-safe slug of the raw name via
`toId`), each independently diffed and reconciled. The sugar only saves
writing the `for` loop at the call site — it creates no new resource type and
owns no list at runtime.
