# System design decisions

A log of real tradeoffs made in this codebase and why. Every entry is reflected
in the current source — this is not a wishlist. See
[ARCHITECTURE.md](./ARCHITECTURE.md) for the resulting structure and
[V1-PLAN.md](./V1-PLAN.md) for what's still open.

---

## Atomic resources, not bundles

The first commit shipped Homebrew-bundle-shaped resources that owned whole lists
of packages. The next refactor reversed it, and the reasoning holds: a resource
that owns "all your packages" can't diff or reconcile any single one
independently, it collapses N unrelated real-world objects into one logical ID,
and a partial failure mid-bundle has no coherent atomic story.

This follows Alchemy's own precedent rather than inventing one. Alchemy has no
generic cross-cloud resource — there is no `Storage.Bucket` abstracting
`AWS.S3.Bucket` and `Cloudflare.R2.Bucket`. `System.Package` applies the same
shape one level down: one generic *resource type*, with `manager` as an explicit
required prop, and all provider-specific behaviour in the backends it dispatches
to. The abstraction lives at the backend layer, not by pretending "install
ripgrep" means the same thing regardless of which tool does it.

`packages()`/`repos()` in `bulk.ts` are sugar, not bundles: the loop runs at
recipe-composition time, and the engine still sees N independently-diffed
resources.

---

## Observation over assumption

**This is the correction that mattered most.**

The previous design had `File`, `ManagedBlock`, `MacOS.Default`,
`System.Package` and `Tailscale.Connection` all diffing against their own
recorded output — the value machine-run last wrote. `MacOS.Default` documented
this explicitly as "a deliberate, cheap optimization... since nothing but
machine-run is expected to touch these keys once managed."

That reasoning is wrong on its own terms. The premise ("nothing else touches it")
is false for every one of those resources — System Settings.app, a macOS update,
`brew uninstall`, a hand-edited `.zshrc`, and a tailnet logout are all ordinary
events. And the cost being optimised away was a sub-millisecond local plist read.
A reconciler that only knows what it wrote is a deployment script with extra
steps.

Every `diff` now observes live state. The one resource that already did this
correctly — `Symlink` — is the model.

### The single exception, and why it's structural

`Machine.SecretFile` diffs on existence, mode, and `ref` — never content.
Hashing a secret would put secret-derived data into Alchemy's unencrypted local
state, which is forbidden outright.

The honest consequence: **secret rotation is undetectable.** Changing `ref` is
caught (it's a prop); rotating the value behind an unchanged `ref` is not. Both
alternatives are worse — store a hash (forbidden), or fetch every secret on every
`plan`, which turns a read-only preview into an operation that hits your vault
and can prompt for biometrics. Deleting the file is the forcing function.

---

## Concurrency is the engine's default, so shared files need a lock

Alchemy applies resources with `concurrency: "unbounded"`. This was not accounted
for anywhere in the previous design, and the result was a silent data-loss bug:
two `ManagedBlock`s targeting one file are independent resources, both do
read-modify-write, and the loser's stanza disappears while the deploy reports
success.

Two mechanisms now address it, at different levels:

1. **`FileLock`** makes concurrent writes to one path safe — no lost updates.
2. **`ManagedBlock.after`** makes their *order* deterministic when order matters.

The second is necessary because safety isn't sufficiency: the file formats
disagree about who wins. `~/.gitconfig` takes the **last** matching `includeIf`;
`~/.ssh/config` takes the **first** matching keyword; `~/.zshrc` is plain
top-to-bottom. So a narrow git persona must land *after* a broad one, and an ssh
catch-all must land *after* the specific hosts.

Alchemy has no user-facing `dependsOn` — ordering comes from one resource's props
referencing another's output, which is what builds the plan edge. So `after`
takes another block's `hash` and never reads it; it exists purely to create the
edge. `position: "prepend"` covers the ssh case for new blocks.

This is opt-in and easy to forget, and forgetting is silent. That's a known
sharp edge, recorded in [V1-PLAN.md](./V1-PLAN.md#5-open-questions).

---

## Backup before first write, gated on `output === undefined`

Every dotfiles resource snapshots the existing file, but only on its first-ever
reconcile. Two things make this the right gate rather than the "branch the whole
reconcile on `output`" anti-pattern Alchemy's doctrine warns about:

1. It is a single conditional side effect, not a second code path. The rest of
   reconcile is identical either way.
2. Running it unconditionally would be actively wrong — it would re-snapshot
   machine-run's *own* previous output on every apply, forever.

The gate captures exactly the one moment that matters: the transition from
unmanaged to managed, which is the only point a real hand-written file could
still be sitting at that path.

Backups go to one run-scoped directory (`~/.local/state/machine-run/backups/
<stamp>/`) mirroring full source paths — not to a `.machine-run-backups` dir
beside each file, which scattered copies across the home tree, put one *inside*
`~/.ssh`, and collided on basename.

A failed backup logs a warning and continues rather than aborting. Aborting would
leave the machine half-configured over a file we were never going to modify well
anyway — but it is never swallowed silently, because the operator needs to know
the safety net wasn't there.

---

## Quoting is a seam, not a detail

Alchemy's `CommandExecutor` takes one `command: string`. With `shell: false` it
splits on whitespace and ignores quotes; with `shell: true` it hands the string
to `/bin/sh`. Neither is safe for a command carrying a value, so every such
command uses `shell: true` **plus** `Sh` quoting.

Windows gets a *separate quoter* rather than a flag, because `shell: true` is
`cmd.exe` there and `'` isn't a quote character at all — POSIX single-quoting
doesn't merely under-perform, it silently passes quote characters through as part
of the argument. This is the actual blocker to Windows support, which is why it
was fixed at the seam before any Windows backend was written.

---

## Fail loudly on malformed input

`renderFile` computed `indexOf(begin)` and `indexOf(end)` independently and
spliced between them. With markers inverted or unpaired, that produced nested,
duplicated garbage that got worse on every run. It now searches for END *after*
BEGIN and raises `ManagedBlockMalformed`.

Same principle in `Symlink`: `readLink(path).pipe(Effect.option)` collapsed every
failure — including permission errors — into "no symlink here", so reconcile
tried to create the link anyway and surfaced an unrelated second error.
`SymlinkPathUnreadable` distinguishes "nothing here" from "couldn't tell".

Same in `Repo`: it silently returned success when a backend lacked repo support.
Apt defines `addRepo` but had no `listRepos`, so the guard never fired and **apt
PPAs were never added** while reconcile reported success.

---

## Symlink refuses to auto-adopt

If `source` doesn't exist, reconcile fails rather than fabricating an empty
placeholder. Bringing a real config under management is a deliberate, reviewed
step — copy it into the repo yourself — because these directories can also
contain credentials that must never be copied into git unreviewed.

That's why `ai-tools` symlinks a hand-picked allowlist and never a tool's whole
config directory: never `auth.json`, `*session*`, `*token*`, `*credential*`,
`*.db`, `logs`, `cache`, or `history.jsonl`.

---

## Secrets never enter state

Alchemy persists both props and attributes, and `localState()` is unencrypted
JSON meant to be committed to a private repo.

- `SecretFile`'s attributes are `{ path }` only. `ref` is a prop and *is*
  persisted — correct, because a pointer to a secret is not a secret.
- Backends return `Redacted.Redacted<string>`, so unwrapping is explicit.
- Secret values reach commands via `env` as `Redacted`, never interpolated into a
  command string — Alchemy's redactor scrubs `env` values from error messages,
  and an interpolated value would be visible in `ps`.

**`Machine.File` is the sharp edge here.** Its `content` is a prop, so it is
written to state verbatim. That's fine for a gitconfig and wrong for anything
credential-shaped. Documented on the resource itself.

Authentication is never automated. A reconciler that can mint its own credentials
to a secret store can exfiltrate every secret in it with no human present.

---

## Testing without `alchemy-test`

`alchemy-test` is Alchemy's own private, unpublished harness. It is broken in the
pinned state (a `queueMicrotask`/`AsyncLocalStorage` interaction) and was
previously recorded as blocking all resource testing.

**Vendoring or patching it was considered and rejected**, for four reasons:

1. It is the *oracle*. A patched fork tells you your code works against your
   patch, not against the real engine — a silent, confidence-inverting failure.
2. The bug is in fiber/context plumbing, which is precisely the part that must
   match upstream for the harness to mean anything.
3. It can't ship. machine-run is meant to be published; an unpublished
   `file:`-only dependency never resolves for anyone else.
4. **It isn't needed.** `Provider.effect(cls, body)` is just
   `Layer.effect(Provider(type), body)`, and the body is an ordinary Effect
   returning an ordinary object — so provider hooks were always directly
   callable. Resources are now written as `Reconciler`s, which goes further:
   `observe`, `desired`, `matches` and `apply` are plain functions with no
   engine ceremony around them at all, so a test builds one against a temp
   directory and calls it.

So the claim that tests were "blocked by an alchemy-test/alchemy version-skew
bug, not our code" was false in both halves. Nothing was blocking them.

What this genuinely doesn't cover — plan ordering, state persistence,
replace/adopt routing — is Alchemy's behaviour to test, not machine-run's.

Deleted tests are not a regression: `File.test.ts` and `Symlink.test.ts` asserted
that `fs.writeFileString` writes a file and `fs.symlink` makes a symlink, while
importing none of the code they claimed to cover. False coverage is worse than
none because it hides the gap.

---

## Node + npm is the default runtime

Node/npm is the lowest-common-denominator runtime nearly every machine already
has. bun and deno are explicit opt-ins (`bootstrap.sh --bun` / `--deno`); deno is
unverified and says so.

The leftover `"types": ["bun"]` in `tsconfig.base.json` from the bun-only era was
not a cosmetic leftover — with no `@types/bun` installed it failed every project
with `TS2688` before any real code was checked. Now `["node"]`.

---

## Strict compiler settings earn their noise

`noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`,
`noImplicitOverride`, `noFallthroughCasesInSwitch` are all on.

This is not stylistic. `noUnusedLocals` is exactly the setting that would have
caught the dangling-provider bug this repo hit twice. `noUncheckedIndexedAccess`
immediately exposed two package-manager backends whose `list()` returned
`(string | undefined)[]` behind a `string[]` signature — a literal `undefined`
was being inserted into the installed-package set, and `includes()` kept working
while the set was quietly wrong.


---

## One copy of Alchemy, enforced by an override

`examples/example-machine` pinned `alchemy@2.0.0-beta.67` while the workspace
root and every `@machine-run/*` package used `beta.72`. Only `effect` deduped,
because the root `overrides` forced it; `alchemy` had no such entry, so npm
installed a second copy nested under the example.

That is not wasted disk space, it is a dual-package hazard. Alchemy's
`Resource`/`Provider` machinery is identity-sensitive — `Resource<File>("Machine.File")`
produces a class from one specific module instance, and a provider registered
against one instance is invisible to a recipe importing another. A recipe with
its own copy would resolve no providers at all, which is a plausible reason
nothing here had ever successfully run.

`alchemy` is now in the root `overrides` alongside `effect`, so the workspace
cannot install two copies regardless of what a package declares. Verified by
`find node_modules -type d -name alchemy` returning exactly one path.

The general rule: anything whose types or classes cross a package boundary by
identity — not just by shape — belongs in `overrides`, because a version skew
in it fails at runtime rather than at resolution.
