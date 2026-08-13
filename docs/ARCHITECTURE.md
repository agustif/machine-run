# Architecture

How machine-run is built. For *why* each tradeoff was made, see
[SYSTEM-DESIGN.md](./SYSTEM-DESIGN.md). For what's missing and the ordered path
to v1, see [V1-PLAN.md](./V1-PLAN.md).

Alchemy is a **dependency**, not a vendored fork. Everything below is written
against the shipped `alchemy@2.0.0-beta.72` and `effect@4.0.0-rc.108` types.

---

## The four layers

```
alchemy               Resource / Provider / Layer / state / CommandExecutor
        │
core                  machine substrate — services, no resources
        │
engine                Reconciler → Alchemy provider
        │
primitives + seams    dotfiles resources; backend interfaces + implementations
        │
domain packages       compose the above; introduce no new engine concepts
```

The constraint that keeps this from sprawling: **a domain package may not
introduce a new engine concept.** It composes primitives and dispatches through a
seam. A genuinely new resource type is a permanent state-schema commitment and
needs an explicit justification.

---

## `@machine-run/core` — the substrate

### What belongs here

A resource answers *"what should be true of this machine?"* — it has desired
state, can drift from it, and can be converged back. Core holds the things that
are true of **the machine you are converging against**, or of **the process
doing the converging**. Those are inputs to every reconcile and the subject of
none.

That distinction is what makes them services rather than resources:

| | A resource | A core service |
|---|---|---|
| Has desired state | yes | no — `MachinePaths` has no target value for "where `~` is" |
| Can drift | yes | no — you cannot drift from your own home directory |
| Is declared in a recipe | yes | no — you never write "I want a lock" |
| Persisted in Alchemy state | yes | never |

Modelling any of them as a resource would put non-state into the state file and
imply an `apply` that does not exist. `FileLock` is the clearest case: it is not
on the machine at all. It is a property of this process, and writing it to a
state file that outlives the process would be meaningless.

### Why it is a package and not part of `dotfiles`

These capabilities are needed above the filesystem layer: `macos-defaults` needs
`Sh`, `secrets` needs `MachinePaths`, `engine` needs `Backups` and `FileLock`.
Housing them in `dotfiles` would make every package depend on the dotfiles
resources to reach a quoting helper.

So core is the one package that depends on nothing else here, and everything
depends on it. That direction is the point: it is the vocabulary the rest of the
system is written in, which is why the concepts below are worth reading before
any resource.

### `MachinePaths`

`expand(path)` resolves a leading `~` and normalises to an absolute path;
`home` is the resolved home directory.

Two problems it fixes. Recipes previously hard-coded literal home directories
(the shipped example said `/home/you` *and* set macOS defaults). And `Symlink`'s
diff compared the live `readLink` target against `news.source` as raw strings, so
`~/vault`, `/Users/a/vault` and `/Users/a/vault/` compared unequal forever —
every plan reported a change and the resource never converged. Normalising both
sides through one service makes "same path" mean one thing.

Backed by `os.homedir()` rather than `$HOME`: it falls back to the passwd entry
when the env var is unset, which is exactly the situation a machine reconciler
runs in under cron, launchd, or a bare `sudo`.

### `FileLock`

`withLock(path, effect)` serialises writes keyed by resolved absolute path.

Alchemy's `Apply.ts` applies resources with `concurrency: "unbounded"`. Every
resource whose props don't reference another resource's output reconciles in
parallel. `ManagedBlock`'s reconcile is a read-modify-write: read the file,
splice the block, write it back. Two blocks in one file are independent
resources, so they race and the loser's stanza is silently dropped.

That's not hypothetical — `gitIdentity()` writes one `includeIf` block per
persona into a shared `~/.gitconfig`, and `sshHost()` writes one `Host` block per
host into a shared `~/.ssh/config`.

The lock table is created **once**, in `core`'s `services()`, and provided
beneath all three dotfiles providers. Three separate `FileLockLive()` instances
would each hand out locks from a private table and exclude nothing.

### `Backups`

`snapshot(path)` copies a file into this run's backup directory, at
`~/.local/state/machine-run/backups/<stamp>/<full-source-path>`.

Three properties make it a safety net rather than clutter. **One directory per
run**, since the timestamp is read once when the service is built — an adopting
deploy leaves one reviewable directory, not one per file. **One location,
outside the tree being managed**, because writing beside each source scatters
copies through the home directory and would put a copy of `~/.ssh/config`
inside `~/.ssh`, whose permissions `ssh` is strict about. **Full source paths,
mirrored**, because two files can share a basename — `config` being the obvious
one.

The stamp comes from `Clock`, so a test can pin it.

### `Sh`

`Sh.sh(...argv)` builds a POSIX-shell-safe command string; `Sh.pwsh(...argv)` the
PowerShell equivalent; `Sh.ref(name)` renders an env-var reference.

Alchemy's `CommandExecutor` takes a single `command: string`, never an argv
array, and has exactly two modes — neither safe alone:

- `shell: false` (default) — Alchemy splits on whitespace
  (`command.split(/(\s+)/)`) and execs the parts. It does **not** understand
  quotes, so `brew install "my pkg"` execs `brew` with the literal args `"my` and
  `pkg"`.
- `shell: true` — goes to `/bin/sh`, which understands quotes but also `;`, `&&`,
  backticks and `$(...)`.

So any command carrying a value needs `shell: true` **and** quoting. Quoting
only the characters that look dangerous is not enough: escaping `"` alone still
leaves `$(...)`, backticks and `\` live inside a double-quoted string.

Windows gets a separate quoter, not a flag: `shell: true` is `cmd.exe` there,
where `'` is not a quote character at all, so POSIX single-quoting is *wrong* in
a way that silently passes quote characters through as part of the argument.
Windows backends set `shell: "powershell.exe"` explicitly.

---

## Resource shape

A resource is written as a **`Reconciler`** from `@machine-run/engine`, and
`toProvider` turns it into an ordinary Alchemy provider. Alchemy still owns
planning, state, ordering, apply and destroy — this is a constructor for
providers, not a second engine.

A reconciler names five things:

```ts
{
  address:  (props) => string                    // what real thing this manages
  observe:  (props, ctx) => State | undefined    // what is actually there
  unapply?: ({ props, observed, recorded }, ctx) => void   // how to undo, if it can
  desired:  (props) => State                     // what the recipe asks for
  matches:  (observed, desired) => boolean       // is the first good enough
  apply:    ({ props, observed, desired }, ctx) => State
}
```

Everything uniform is then decided **once**, in the adapter:

| Concern | How it is settled |
|---|---|
| Drift detection | `diff` is `observe` compared with `desired`; a resource cannot opt out, so none can be blind to outside changes |
| Prop coverage | comparison is over whole states, so no prop can be silently omitted |
| Mutual exclusion | applies are serialised on `address` |
| Snapshot before overwrite | taken from `address` when `snapshotBeforeApply` is set |
| Plan vs apply capability | `observe` gets a non-reporting session, `apply` the live one |
| `delete` | retains by default; reverses only under an explicit `destroy` policy, and only if the reconciler defines `unapply` |

`matches` is deliberately *not* equality: desired state is frequently partial.
A file that does not pin its mode is satisfied by any mode, so a reconciler
compares only what the props actually constrain.

A `Reconciler` cannot express everything a provider can — there is no
`replace`, `stables`, or `precreate`. Those go through `toProvider`'s
`overrides` parameter, and a resource needing substantially more calls
`Provider.effect` directly. Both kinds compose in one stack, because both are
just providers.

### Props and state are schemas

Resource props and attributes are declared with `Schema.Struct` and the
TypeScript type is derived (`typeof X.Type`), rather than written as an
interface and asserted. Both cross a boundary worth describing once: props
arrive from a recipe, and attributes are persisted to Alchemy's state file as
JSON and handed back on a later run.

Closed sets — `PackageManagerId`, `SecretBackendId`, `Position` — are
`Schema.Literals`, so membership exists at runtime rather than only in the
compiler.

Recursive shapes are the exception: `PlistValue` keeps hand-written interfaces
and annotates `Schema.suspend` with them. That is Effect's own idiom for
recursion, and here it is also required, because Alchemy maps every prop type
through `Input<>`, which expands a self-referential *alias* until the compiler
reports "type instantiation is excessively deep".

### `diff` observes live state

This is the property everything else rests on.

A resource that compares desired state against its own recorded attributes
answers "did the recipe change?" — never "does the machine match the recipe?".
The two diverge the moment anything else touches the machine, which is the
normal case: a hand-edited `.zshrc`, a package removed with `brew uninstall`, a
`defaults` key reset by an OS update, a tailnet logout. A resource that cannot
see any of those is a deployment script with extra bookkeeping.

Every `diff` therefore reads reality:

| Resource | Observation |
|---|---|
| `Machine.File` | hash of the file on disk + its live mode bits |
| `Machine.ManagedBlock` | the text actually between the markers, via `readBlock` |
| `Machine.Symlink` | `readLink` target, both sides path-normalised |
| `Machine.SecretFile` | existence + mode only — never content (see below) |
| `MacOS.Default` | the key extracted from `defaults export` as XML, canonicalised |
| `System.Package` | the manager's installed list, memoised per manager |
| `Tailscale.Connection` | `tailscale status --json`, Schema-decoded |

`diff` also honours **all** props, not just content. Keyed on a content hash
alone, changing `path`, `marker`, `mode`, `ref` or `source` was a silent no-op —
repointing a `SecretFile` at a different vault item left the old secret on disk.

Every `diff` still opens with `if (!isResolved(news)) return undefined;` from
`alchemy/Diff`, before touching any prop.

### `read` enables adoption

Alchemy calls `read` only when there is no prior state, to decide between
create / silent-adopt / fail-as-unowned (see Alchemy's `AdoptPolicy`). The
dotfiles resources implement it so a machine that is already correct is adopted
rather than treated as a greenfield create. It is **not** a per-plan drift
probe — that's `diff`'s job, above.

### `delete` retains by default

`alchemy destroy` clears Alchemy's bookkeeping and leaves the machine alone: no
package is uninstalled, no region removed, no symlink deleted, no materialised
secret erased, no setting reverted.

That default is chosen rather than inherited. Alchemy's own class-level
fallback for an unset `RemovalPolicy` is `"destroy"`, which is right for cloud
resources — an orphaned load balancer costs money — and wrong for a laptop,
where the same default would uninstall your software because you ran a command
without reading its docs. `toProvider` re-decides it, so `retain` holds
repo-wide without every resource opting in.

A resource *can* reverse itself, by implementing `Reconciler.unapply`. It runs
only under an explicit `"destroy"` policy, only if the reconciler defines it,
and only after re-observing inside the address lock — so a resource already
removed by hand is left alone rather than "undone" twice. It receives the
recorded attributes alongside the live observation, because some undo paths
need bookkeeping that observation cannot recover, such as where a backup was
written.

**No resource implements `unapply` yet.** The mechanism exists; the policy
question — which resources can honestly claim to reverse themselves — is
deliberately still open, and is tracked in
[V1-PLAN.md](./V1-PLAN.md#5-open-questions). Reverting a `defaults` key has no
defined "before" if the original was never recorded, and restoring a backup is
only correct if the backup is still the right answer.

---

## The backend seam

One interface, one small module per implementation, one generic resource
dispatching by id. Applied to two families today.

```
system-packages/src/               secrets/src/
  Backend.ts     PackageManagerBackend   Backend.ts   SecretBackend
  backends/                              backends/
    Brew.ts    (brew + brew-cask)          OnePassword.ts
    MacPorts.ts  Apt.ts  Dnf.ts            Doppler.ts
    Pacman.ts  Cargo.ts  Npm.ts            Keychain.ts
    Winget.ts  Choco.ts                    Pass.ts
  Package.ts / Repo.ts  ← dispatch        Env.ts
                                         Store.ts     ← dispatch
                                         SecretFile.ts
```

**Adding a backend means writing one module and adding one id.** Never a new
resource type per backend, and never a special case inside the generic
resource's `diff`/`reconcile`.

### `SecretBackend` specifics

`read` returns `Redacted.Redacted<string>`, not a bare `string`. Alchemy's
command redactor only scrubs values it knows are secret; a bare string is one
template literal away from a `CommandError` message, a log line, or `ps` output.
Making it type-level opaque means unwrapping is a visible, greppable act.

Values are returned **verbatim**, because whitespace can be significant and no
single policy is right for every secret: OpenSSH rejects a private key that does
not end in a newline, while a token file with a stray newline breaks any
consumer doing an exact comparison. `SecretFile` exposes the choice as an
explicit `trailingNewline` prop rather than guessing.

Note what the interface deliberately does *not* cover. Doppler can also inject
secrets as environment variables into one command, which is useful but is not a
store *read* — it cannot answer "what is this value", so it cannot back
`SecretFile`. That shape belongs on a command-running resource instead.

---

## Typed errors

Errors come from parsing CLI output, so the boundary is hand-authored
`Data.TaggedError` classes. Callers use `Effect.catchTag`, never `_tag === "..."`
on `unknown`.

`SymlinkSourceMissing`, `SymlinkPathUnreadable`, `ManagedBlockMalformed`,
`UnsupportedPlatform`, `BackendParseError`, and the secrets family
(`SecretCliMissing`, `SecretAuthRequired`, `SecretReadFailed`,
`SecretRefInvalid`).

Two notes on honesty here:

- **CLI-message classification is best-effort.** `SecretCliMissing` /
  `SecretAuthRequired` are inferred from substrings in a `CommandError` message.
  CLI wording is not a stable API. The classifiers exist to tell the user what to
  *do next*; `SecretReadFailed` is the honest fallback and control flow should
  not depend on the finer buckets.
- **Platform failures are read structurally.** Effect 4's `PlatformError` carries
  `reason: BadArgument | SystemError` with a normalised `_tag`, so
  "does this path exist" is a typed field read (`reason._tag === "NotFound"`),
  not a message match.

---

## Effect platform services, not raw Node

Resource code uses `FileSystem.FileSystem` and `Path.Path`, never `node:fs`/
`node:path`, and `CommandExecutor` from `alchemy/Command`, never
`child_process`.

Three deliberate exceptions, each a fact about the host with no Effect-native
equivalent: `os.homedir()` in `MachinePaths`, `process.platform` in `detect.ts`,
and `crypto.subtle.digest` in `sha256` (genuinely async, so lifted with
`Effect.promise`).

### Effect 4, not Effect 3

The API differences are not cosmetic and have already cost this repo a full
build:

| Effect 3 | Effect 4 |
|---|---|
| `Context.Tag.Service<typeof X>` | `typeof X.Service` |
| `Effect.catchAll` | `Effect.catch` |

`Context.Tag` **does not exist** in Effect 4. Writing
`Context.Tag.Service<typeof CommandExecutor>` compiles to `unknown` and silently
erases downstream types — that single line produced 43 cascading errors in
`system-packages`. Always verify an API against `node_modules/effect/dist/*.d.ts`
before using it.

---

## Schema at the parse boundary

`JSON.parse(x) as T` is a lie: it tells the compiler the shape was verified when
nothing checked it. The npm and tailscale backends now decode with
`Schema.fromJsonString` + `Schema.decodeUnknownEffect`, producing a typed
`BackendParseError` at the boundary instead of `undefined is not an object` deep
inside `Object.keys`.

---

## Package graph

```
core
├── engine ────┬── dotfiles ──┬── git-identity
│              ├── ssh
│              └── ai-tools
├── secrets ───── tailscale
├── macos-defaults
└── system-packages
```

Cross-package dependencies are declared as **TypeScript project references**, not
left to the root tsconfig's incidental listing order.

Each package ships a `providers()` Layer. `core`'s `services()` must be provided
**once** per stack, beneath everything else, so the `FileLock` table is shared.

A missing provider in a recipe's `providers` merge is a **silent runtime
failure** — this repo has hit that exact bug twice. The example recipe carries a
warning comment about it; a single aggregate layer is on the plan.
