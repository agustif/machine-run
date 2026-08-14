# MUST_CLEANUP

Things that are *wrong* rather than missing. [docs/TASKS.md](./docs/TASKS.md) is
the work backlog; this is the defect list, ordered by cost.

**Bar for an entry:** a file and line, a reason, and a cost — not a feeling. A
false positive here gets working code "fixed".

**Bar for removal:** the smell is gone, not renamed. Fixed entries are deleted,
not annotated.

Entries marked *verified* were re-read line by line. The rest carry a file and
line from an audit but were not independently re-read.

---

## Tier 1 — costs correctness

---

## Tier 1b — remaining correctness risks

---

### 1b.7 Nothing checks that resources sharing a file share an address

`Reconciler.address` is where the engine derives mutual exclusion and
pre-overwrite snapshotting, so two resources writing one file must produce the
same string. Addresses are paths in 13 kinds and synthetic keys in the rest
(`defaults:<domain>`, `gsettings:<schema>:<key>`, `<manager>`). `Ai.McpServer`
was a concrete collision and is now fixed: supported MCP backends use their
real config-file path, while unsupported tools retain a synthetic address only
because they have no writable file and fail before the address matters. The
remaining gap is that the engine has no general declaration or test that proves
two independently-written paths share an address.

**Fix:** have a reconciler declare the real paths it writes, so this is
checkable rather than found by reading all 29 address implementations at once.

## Tier 1c — the architectural finding, mostly addressed

Three separate audits, hunting three different things, converged on one shape;
the high-risk instances are now fixed, but the general contracts remain
partly conventional.

**The architecture is sound. The abstractions fit. The audit's concrete
correctness failures have been moved into shared seams where practical; the
remaining risk is the set of disciplines that still lack a type-level contract.**

The evidence, measured rather than asserted:

- The engine abstraction *fits*: 23 of 23 resources use `toProvider` with zero
  escapes (2.1).
- Error modelling is coherent: 113 `Data.TaggedError`, zero `Schema.TaggedError`
  — matching Alchemy's own choice rather than diverging from it.
- No raw `process.env` anywhere in source; `Config` is used throughout.
- Parsing splits correctly: `Schema` where a tool emits JSON, hand-written
  parsing where it emits fixed-width text that `Schema` genuinely cannot express.
- `Machine.Exec` is not a duplicate of Alchemy's `Command.Exec`: ours is
  idempotent by *observing a guard*, theirs re-runs on input change. Different
  resources, and `Machine.providers()` deliberately excludes Alchemy's.

The review found this repetition and the high-risk instances are now encoded in
shared seams: `readIfPresent`/`statIfPresent` preserve absent-versus-unreadable,
the service and settings backends classify only known absence outcomes, and
package/repository/default resources perform fresh read-after-write checks.
The remaining work in this file is now about boundaries the shared seams do not
model yet — ownership, address collisions, and the intentionally best-effort
XDG config discovery in `Git.Config`.

---

## Tier 1d — execution context is now explicit; machine ownership remains open

`ExecutionContext` now carries privilege, locale and the default timeout. The
provider boundary injects the locale and timeout defaults, while backends own
their verified operation budgets through `core/Timeouts.ts`.

### 1d.3 File ownership is not modelled at all

`mode` is handled meticulously — POSIX bits, a Windows ACL translation, a
`FilePermissions` type. `uid`/`gid` appear nowhere.

A file written under `sudo` is owned by root. `matches` compares mode only, so
it reports converged permanently while the user cannot read their own config.
The gap is invisible precisely because the neighbouring concept is so carefully
modelled.

### 1d.5 Paths are bare strings, held correct by hand

28 props typed `path: Schema.String`, and 40 manual `paths.expand(...)` calls.

Every one is currently correct — verified: no path prop reaches the filesystem
or a command unexpanded. But nothing makes the 41st correct. A branded
`MachinePath` separating *authored* (may contain `~`) from *resolved* would make
the mistake unrepresentable instead of merely absent so far.

This is the same pattern as `readIfPresent` and `ShellCommand`: a discipline that
holds until it doesn't.

### 1d.6 Defaults are scattered literals

`0o700` ×12, `0o600` ×6, `0o755` ×3, `0o644` ×3, `0o777` ×8, each redeclared at
its use site. There is no policy object saying what this tool's defaults *are*,
so changing one means finding all of them.

### 1d.7 Absent entirely

- **No "requires reboot / re-login" signal.** `chsh` takes effect next login;
  `defaults` needs an app restart, handled ad-hoc via `restartApp`. A resource
  cannot say the machine is not really converged yet.
- **No OS-level lock handling.** `FileLock` serialises *our* writes; nothing
  handles `dpkg` holding `/var/lib/dpkg/lock` because unattended-upgrades is
  running.
- **No architecture concept** — arm64 vs x86_64, Rosetta.
- **No TOCTOU protection** on paths this tool does not own: it writes
  `~/.ssh/id_ed25519` without checking `~/.ssh` is not a symlink elsewhere.
- **No partial-failure story.** Apply dies at resource 20 of 40 and nothing
  describes the resulting state.

### 1d.8 Remaining execution-context boundary

The privilege, locale and timeout parts of the proposed `ExecutionContext` are
implemented. Architecture and file ownership are still not modelled, and
resource paths remain plain strings expanded by convention. Those are separate
gaps: adding architecture or uid/gid fields without a concrete backend need
would widen every schema without making a current resource safer.

---

## Tier 2 — design drift

### 2.2 One directory, two mechanisms — and it is spreading

`Machine.Directory` is a resource for "a directory should exist with this mode".
`directoryMode` is also a prop on **eight** resources:
`dotfiles/src/{File,ManagedBlock,LineInFile,Template}.ts`,
`secrets/src/SecretFile.ts`, `ssh/src/{Key,KnownHost,Host}.ts`.

This was already logged when it was three files. It reached eight because every
new resource copied the pattern from its neighbour — which is the real cost of
leaving a duplicated concept in place: it is the example the next author follows.

**Fix:** pick one. Either `directoryMode` disappears and a recipe declares a
`Machine.Directory` it depends on, or `Machine.Directory` is for standalone
directories only and that is written down where the eight can see it.

### 2.3 Nine namespaces for twenty-three resource kinds

`Machine.*`, `System.*`, `MacOS.*`, `Runtime.*`, `Shell.*`, `Git.*`, `Ai.*`,
`Tailscale.*`, `Ssh.*`. `Machine.SecretFile` lives in `secrets`, `Machine.File`
in `dotfiles`, `System.Package` in `system-packages` but `System.Setting` in
`system-settings`. The `Machine`/`System` split tracks nothing a reader can
predict, and every new resource picks a namespace by imitation.

Safe to do whenever: `Resource(type, { aliases })` carries pre-rename names and
`tryFindProviderByType` falls back to them, so persisted state keeps resolving
(`packages/engine/test/aliases.test.ts`). Not a release blocker.

**Fix:** settle it now that `deploy` works and there is evidence about which
split reads well, listing every old name in `aliases`.

## Tier 3b — duplication, counted

From the duplication audit; the first entry re-verified while writing this.

### 3b.3 `directoryMode`, quantified

Seven resources each declare their own `directoryMode` prop
(`File.ts:36`, `ManagedBlock.ts:73`, `LineInFile.ts:82`, `Template.ts:128`,
`SecretFile.ts:31`, `KnownHost.ts:49`, `Key.ts:48`). The shared
`core` `DEFAULT_DIRECTORY_MODE` now owns the `0o700` default, and every writer
uses `Fs.ensureParentDir`; the remaining issue is the API decision in 2.2 about
whether these props should exist alongside `Machine.Directory` at all.

The cost is sharper than "repetition": two resources can disagree about the same
directory's mode and nothing detects it. See 2.2.

### 3b.4 `BackendParseError` defined twice, plus a near-copy

`system-packages/src/Backend.ts:7-13` and `runtimes/src/Backend.ts:8-14` are the
same class with the same runtime `_tag`. `system-services/src/Backend.ts:22-28`
is a third with the field renamed. Two distinct classes sharing one tag string
breaks the moment anything unions them or keys telemetry by tag.

### 3b.6 `fakeExec` copied into seven test files

Identical four-line helper in `runtimes`, `system-packages` (×2),
`system-services`, `system-settings` (×2) and `secrets` tests. If `Exec`'s result
shape gains a field, seven files need the same edit. `git`'s variants genuinely
differ (they model exit codes) and should stay.

### 3b.8 One fact, five documents

"Alchemy applies with `concurrency: unbounded`, therefore `FileLock` exists" is
independently derived — not cross-referenced — in `AGENTS.md` §7,
`ARCHITECTURE.md:90-101`, `SYSTEM-DESIGN.md:68-76`, `V1-PLAN.md:50` and
`CONCEPTS.md`. Five places must agree if the concurrency model or the lock's
scope ever changes.

### 3b.9 Backend registries live in three different places

`ai`, `secrets`, `shell`, `system-settings` use a root `Store.ts`;
`system-packages` and `system-services` inline the map in the resource file;
`git` nests `Backend.ts` and `Store.ts` under `src/backends/`, contradicting the
layout `AGENTS.md` §13 documents. Three answers to "where does this seam
register its backends".

---

## Tier 4 — process smells

## Judged clean — do not "fix" these

Checked and found correct. Listed so the next audit does not spend time here.

- **`silentSession`** (`core/src/Sessions.ts:36`) — a no-op progress session
  looks like a stub. It is deliberate and documented: `diff`/`read` receive no
  session, and a plan-time probe's output is not progress the operator asked to
  watch. Explicitly *not* used in `reconcile`.
- **`Backups.snapshot` swallowing its failure** — a failed backup logs and
  returns no path rather than aborting. Correct: a backup must never abort a
  deploy. It is loud, not silent.
- **Per-tool backend duplication** — ~50 backend modules that look repetitive
  are wrapping genuinely different CLIs. A shared abstraction over `brew list`
  and `winget list` would be worse than the repetition; the winget parser needed
  column-offset slicing that no sibling wants.
- **Two examples** — `example-machine` (meant to run) and `complete-machine`
  (every kind, as a compiled reference) have different jobs, and the second is
  enforced by a test.
- **`macos-defaults/src/Default.ts:130-134`** — the `killall` swallow. Three
  independent checks agreed: `killall` exits non-zero when the app is not
  running, the swallow wraps only that one exec, and the `defaults write` two
  lines earlier still dies loudly via `Effect.die` at the outer `catchTag`.
- **`system-packages/src/detect.ts:28-29`** — an unreadable distro marker is
  treated as "not this distro", documented as intentional. Composition-time
  only, and the user can name the manager explicitly.
- **`secrets/backends/*`** — CLI-text error classification with a documented
  generic fallback is AGENTS.md rule 11 working as intended, not a swallow.
- **`PackageIndex.ts`'s plan/apply cache split** — two independent memoized
  listings rather than one shared cache, deliberately, so a plan-time result
  cannot mask drift at apply time.
- **`lines()` duplicated between `system-packages` and `runtimes`** — six lines
  of pure string handling, with the runtimes copy's own doc comment explaining
  the choice. A shared package for six lines of trimming would be worse.
- **The 19 package-manager backends looking alike** — each carries a verified
  quirk (pipx's empty-state banner, cargo's indented sub-lines, uv-tool's `v\d`
  header, gem's comma-joined versions). Collapsing them would either lose those
  or smuggle them back as conditionals. `parse.ts`'s `lines`/`firstTokens`
  already extract the genuinely common part; that is the right cut.
- **`GitRepoCommandFailed` / `GitConfigCommandFailed` / `GitMaintenanceCommandFailed`**
  — structurally identical, deliberately distinct tags, because `catchTag` needs
  to know which resource failed.
- **`Ssh.KnownHost` not built on `Machine.LineInFile`** — it compares structural
  host/keyType/publicKey fields, not a generic regex. Real specialisation.
- **`Git.Maintenance.repo` vs `Git.Repo.path`** — `repo` mirrors git's own
  `maintenance.repo` config key, so it tracks external vocabulary.
- **`as` in `packages/cli/src/Commands.ts`** — one narrowing, named
  (`withoutEvalStackInternals`), bounded to exactly the two services `evalStack`
  provides internally, so a third requirement appearing later is a compile error
  rather than being silently absorbed.
