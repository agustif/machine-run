# System design decisions

Real tradeoffs made in this codebase and why. See
[ARCHITECTURE.md](./ARCHITECTURE.md) for the resulting structure and
[V1-PLAN.md](./V1-PLAN.md) for what's still open.

---

## Atomic resources, not bundles

A resource that owns "all your packages" can't diff or reconcile any single
one independently, collapses N unrelated real-world objects into one logical
ID, and gives a partial failure mid-bundle no coherent atomic story.

This follows Alchemy's own precedent: there is no generic cross-cloud
resource abstracting `AWS.S3.Bucket` and `Cloudflare.R2.Bucket`.
`System.Package` applies the same shape one level down — one generic
*resource type*, with `manager` as an explicit required prop, and all
provider-specific behaviour in the backends it dispatches to.

`packages()`/`repos()` in `bulk.ts` are sugar, not bundles: the loop runs at
recipe-composition time, and the engine still sees N independently-diffed
resources.

---

## Observation over assumption

Every `diff` observes live state — `File`, `ManagedBlock`, `MacOS.Default`,
`System.Package`, `Tailscale.Connection`, all of it. A reconciler that only
knows what it wrote is a deployment script with extra steps: System
Settings.app, a macOS update, `brew uninstall`, a hand-edited `.zshrc`, and a
tailnet logout are all ordinary events a reconciler has to notice.

### The single exception, and why it's structural

`Machine.SecretFile` diffs on existence, mode, and `ref` — never content.
Hashing a secret would put secret-derived data into Alchemy's unencrypted
local state, which is forbidden outright.

The honest consequence: **secret rotation is undetectable.** Changing `ref`
is caught (it's a prop); rotating the value behind an unchanged `ref` is not.
Both alternatives are worse — store a hash (forbidden), or fetch every secret
on every `plan`, which turns a read-only preview into an operation that hits
your vault and can prompt for biometrics. Deleting the file is the forcing
function.

---

## Concurrency is the engine's default, so shared files need a lock

Alchemy applies resources with `concurrency: "unbounded"`. Two
`ManagedBlock`s targeting one file are independent resources, both do
read-modify-write, so without a lock the loser's stanza silently disappears
while the deploy reports success.

Two mechanisms address it, at different levels:

1. **`FileLock`** makes concurrent writes to one path safe — no lost updates.
2. **`ManagedBlock.after`** makes their *order* deterministic when order
   matters.

The second is necessary because safety isn't sufficiency: file formats
disagree about who wins. `~/.gitconfig` takes the **last** matching
`includeIf`; `~/.ssh/config` takes the **first** matching keyword;
`~/.zshrc` is plain top-to-bottom. So a narrow git persona must land *after*
a broad one, and an ssh catch-all must land *after* the specific hosts.

Alchemy has no user-facing `dependsOn` — ordering comes from one resource's
props referencing another's output, which is what builds the plan edge. So
`after` takes another block's `hash` and never reads it; it exists purely to
create the edge. `position: "prepend"` covers the ssh case for new blocks.

This is opt-in and easy to forget, and forgetting is silent — a known sharp
edge, recorded in [V1-PLAN.md](./V1-PLAN.md#design-questions-still-open).

---

## Backup before first write, gated on `output === undefined`

Every dotfiles resource snapshots the existing file, but only on its
first-ever reconcile:

1. It is a single conditional side effect, not a second code path. The rest
   of reconcile is identical either way.
2. Running it unconditionally would be actively wrong — it would re-snapshot
   machine-run's *own* previous output on every apply, forever.

The gate captures exactly the one moment that matters: the transition from
unmanaged to managed, the only point a real hand-written file could still be
sitting at that path.

Backups go to one run-scoped directory
(`~/.local/state/machine-run/backups/<stamp>/`) mirroring full source paths,
rather than a `.machine-run-backups` dir beside each file — that avoids
scattering copies across the home tree and colliding on basename.

A failed backup logs a warning and continues rather than aborting — aborting
would leave the machine half-configured over a file we were never going to
modify well anyway — but it is never swallowed silently, because the
operator needs to know the safety net wasn't there.

---

## Quoting is a seam, not a detail

Alchemy's `CommandExecutor` takes one `command: string`. With `shell: false`
it splits on whitespace and ignores quotes; with `shell: true` it hands the
string to `/bin/sh`. Neither is safe for a command carrying a value, so every
such command uses `shell: true` **plus** `Sh` quoting.

Windows gets a *separate quoter* rather than a flag, because `shell: true` is
`cmd.exe` there and `'` isn't a quote character at all — POSIX
single-quoting doesn't merely under-perform, it silently passes quote
characters through as part of the argument.

---

## Fail loudly on malformed input

Never guess through a file whose structure is wrong. `renderFile` raises
`ManagedBlockMalformed` rather than splicing between independently-computed
marker positions. `Symlink`'s `SymlinkPathUnreadable` distinguishes "nothing
here" from "couldn't tell" instead of collapsing every `readLink` failure
into "no symlink here." `Repo` fails rather than silently returning success
when a backend lacks repo support for a requested operation.

---

## Symlink refuses to auto-adopt

If `source` doesn't exist, reconcile fails rather than fabricating an empty
placeholder. Bringing a real config under management is a deliberate,
reviewed step — copy it into the repo yourself — because these directories
can also contain credentials that must never be copied into git unreviewed.

That's why `ai` symlinks a hand-picked allowlist and never a tool's whole
config directory: never `auth.json`, `*session*`, `*token*`, `*credential*`,
`*.db`, `logs`, `cache`, or `history.jsonl`.

---

## Secrets never enter state

Alchemy persists both props and attributes, and `localState()` is
unencrypted JSON meant to be committed to a private repo.

- `SecretFile`'s attributes are `{ path }` only. `ref` is a prop and *is*
  persisted — correct, because a pointer to a secret is not a secret.
- Backends return `Redacted.Redacted<string>`, so unwrapping is explicit.
- Secret values reach commands via `env` as `Redacted`, never interpolated
  into a command string — Alchemy's redactor scrubs `env` values from error
  messages, and an interpolated value would be visible in `ps`.

**`Machine.File` is the sharp edge here.** Its `content` is a prop, so it is
written to state verbatim. That's fine for a gitconfig and wrong for anything
credential-shaped. Documented on the resource itself.

Authentication is never automated. A reconciler that can mint its own
credentials to a secret store can exfiltrate every secret in it with no
human present.

---

## Testing without `alchemy-test`

`alchemy-test` is Alchemy's own private, unpublished harness, broken in the
pinned state (a `queueMicrotask`/`AsyncLocalStorage` interaction). Vendoring
or patching it was considered and rejected:

1. It is the *oracle*. A patched fork tells you your code works against your
   patch, not against the real engine.
2. The bug is in fiber/context plumbing, which is precisely the part that
   must match upstream for the harness to mean anything.
3. It can't ship — machine-run is meant to be published, and an unpublished
   `file:`-only dependency never resolves for anyone else.
4. It isn't needed: `Provider.effect(cls, body)` is `Layer.effect(Provider(type),
   body)`, and the body is an ordinary Effect returning an ordinary object.
   Resources are written as `Reconciler`s, whose `observe`, `desired`,
   `matches` and `apply` are plain functions with no engine ceremony — a test
   builds one against a temp directory and calls it directly.

What this genuinely doesn't cover — plan ordering, state persistence,
replace/adopt routing — is Alchemy's behaviour to test, not machine-run's.

---

## Node + npm is the default runtime

Node/npm is the lowest-common-denominator runtime nearly every machine
already has. bun and deno are explicit opt-ins (`bootstrap.sh --bun` /
`--deno`); deno is unverified and says so. `tsconfig.base.json`'s `types` is
`["node"]`.

---

## Strict compiler settings earn their noise

`noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`,
`noImplicitOverride`, `noFallthroughCasesInSwitch` are all on. This is not
stylistic: `noUncheckedIndexedAccess` is exactly the setting that surfaces a
package-manager backend whose `list()` returns `(string | undefined)[]`
behind a `string[]` signature, where a literal `undefined` inserted into the
installed-package set lets `includes()` keep "working" while the set is
quietly wrong.

---

## One copy of Alchemy and one copy of Effect, enforced by overrides

Alchemy's `Resource`/`Provider` machinery is identity-sensitive —
`Resource<File>("Machine.File")` produces a class from one specific module
instance, and a provider registered against one instance is invisible to a
recipe importing another. So both `alchemy` and `effect` are pinned in the
root `overrides`, which forces every package in the workspace to resolve to
one exact copy of each regardless of what its own `package.json` declares.
Verified by `find node_modules -type d -name alchemy` returning exactly one
path.

The general rule: anything whose types or classes cross a package boundary
by identity — not just by shape — belongs in `overrides`, because a version
skew in it fails at runtime rather than at resolution.

Every `@machine-run/*` package declares `effect`, `@effect/platform-node` and
`alchemy` as **peer** dependencies with ranges, which is the right
declaration for a published library — but npm's default response to a peer
range is to auto-install placeholder nodes into nested `node_modules`, which
can materialise a second real copy structurally identical to but distinct
from the first. `legacy-peer-deps=true` in `.npmrc` stops this: the root's
own `dependencies` plus `overrides` already pin one exact version of every
peer, so peer resolution has nothing left to decide. The alternative,
`peerDependenciesMeta.optional` on every peer, was rejected because it would
be a lie in published metadata — these packages genuinely cannot work
without `effect`.

The cost is that peer *conflict checking* is off too, acceptable only because
`overrides` pins exact versions; if those pins are ever loosened, this needs
revisiting. CI runs `npm ci` rather than `npm install` for the same reason —
it installs the committed lockfile instead of re-resolving a graph nobody ran
locally. `ioredis`, a required peer of `@effect/platform-node`'s `NodeRedis`
barrel that npm's auto-install used to supply, is a direct dev dependency;
Alchemy's other ten unfulfilled peers are all `optional: true` and correctly
absent.
