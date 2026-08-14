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

### 1.2 Three of twenty-three resources can undo themselves

`Shell.Login`, `System.Setting` and `Git.Maintenance` implement `unapply`. The
other twenty do not, so `destroy` is a no-op for them.

This is only half a smell — the removal policy defaults to `retain` precisely
because uninstalling a package someone now depends on is not obviously correct,
and two refusals are already reasoned in writing (`Ssh.Key`, because a generated
private key is unrecoverable; `Tailscale.Connection`, because logging out could
cut the operator's own access).

The smell is the **silence**: eighteen resources have no recorded decision
either way. A reader cannot tell "we decided not to" from "nobody thought about
it", which is exactly the distinction this repo claims to care about.

**Fix:** a one-line decision per resource, in its own doc comment. Not
necessarily an implementation.

### 1.3 `ExampleCoverage` checks resources, not compositions

`packages/machine/test/ExampleCoverage.test.ts` enumerates every
`Resource<T>("Type.Name")` and fails if one is unexercised. It does not look at
the composition functions — `gitIdentity`, `aiSkill`, `sshHost`, `envVar`,
`func`, and about a dozen more — so those can rot undetected.

Found the way such things are found: `shell`'s `func` composition exists, is
backed by `ShellBackend.renderFunction`, has its own tests, and appears in
neither `MAP.md`'s table nor the reference example. The resource guard could not
have caught it.

**Fix:** extend the same source-reading check to exported composition functions,
or accept the gap explicitly and say why.

### 1.4 Nothing can upgrade, and no backend refreshes its index

Verified by grep across all 19 package backends: **zero** occurrences of
upgrade, update, `-Sy` or refresh. `Package.ts`'s `apply` calls only
`backend.install`.

**A machine managed by this tool never receives an update through it.** Once a
package is present, `matches` compares presence, finds it, and reports converged
— permanently. Combined with 2.6 (no way to pin a version) that means the tool
installs a machine once and then reports it healthy indefinitely while it drifts
underneath. Security updates included.

Second, smaller, and immediate: no backend refreshes its index before
installing. `apt install <pkg>` against a stale index fails with "Unable to
locate package" for anything recent, and `pacman -S` without `-Sy` does the
same. Any container test that works around this with a manual `apt-get update`
is hiding it.

**Fix — this is one design with 2.6, not two:**

- `VersionSpec` — what the recipe wants.
- **Drift with a direction.** `matches` returns a boolean, which cannot separate
  "installed 1.2, want 1.3" (behind, upgradable) from "installed 1.4, want 1.3"
  (ahead, usually *not* downgradable). A boolean forces the same action for
  opposite situations. This is the concrete case for the `matches` → typed
  reason change already proposed.
- **`UpdatePolicy`** — `Never` (install once, then leave alone — defensible and
  probably the common choice), `ToSpec`, `Latest`.

That last one is what makes the whole design cohere: **`Latest` is not a version,
it is an update policy.** Modelling it as a version is why it currently hides as
the silent default.

---

## Tier 1b — wrong results (from the audit, not independently re-verified)

### 1b.1 Exit codes collapsed into a definite answer

`packages/system-services/src/backends/linux/SystemdUser.ts:74-80,96-105` and
`macos/Launchd.ts:117-123`.

`observeEnabled`/`observeActive` treat *every* non-zero exit as a definite
"disabled"/"not running", not only the verified codes. `systemctl --user`
without a reachable D-Bus user session — cron, ssh, no lingering session — exits
non-zero with a bus error that is indistinguishable by exit code from genuinely
disabled. `matches` then reports false convergence and hides real drift.

This is the same hazard class already found and mitigated for `gsettings`,
reappearing in a package written later.

**Fix:** collapse only the specific verified codes; propagate anything else.

### 1b.2 `Codex` treats every command error as "server absent"

`packages/ai/src/backends/Codex.ts:89-96`. The swallow is justified for
"command not found" and is documented for a specific stderr message, but the
code checks only the former, so a corrupted `$CODEX_HOME` or a permissions
problem reads as absent and `apply` blindly re-adds the server.

`Grok.ts` in the same package does the correct thing, right next to it.

**Fix:** match the documented stderr text, propagate the rest — the pattern
`git/src/toplevel.ts:36` already uses.

### 1b.3 `Git.Repo` folds unreadable into absent

`packages/git/src/Repo.ts:175,184-186`. Same shape as 0.2–0.4: a permission
error on the parent reads as "nothing here", so the plan says "clone". Lower
severity because the clone then fails loudly, so it is a wrong plan rather than
lost data.

### 1b.4 `System.Setting`'s `unapply` can report a false failure

`packages/system-settings/src/Setting.ts:409-418` raises
`SettingResetNotObserved` when the post-reset value equals what was written —
but if the schema default happens to equal it, a successful reset reports as a
failure. Notably the *inverse* of everything else here: a false negative, not a
false success.

### 1b.5 Read-after-write confirmation is applied to two resources out of five

`System.Setting` and `System.Service` re-read after writing and raise if the
write did not take (`Setting.ts:375-391`, `Service.ts:218-249`), citing the
`gsettings` silent-no-op precedent. `System.Package` (`Package.ts:179-197`),
`System.Repo` (`Repo.ts:150-165`) and `MacOS.Default` (`Default.ts:118-139`) do
not.

The audit found no live bug of this shape in the 19 package-manager backends, so
this is a **defensive-posture gap, not a demonstrated failure**. It is listed
because it is the same coherence problem as 0.5: a lesson learned once and
encoded in two places out of five.

---

### 1b.7 Nothing checks that resources sharing a file share an address

`Reconciler.address` is where the engine derives mutual exclusion and
pre-overwrite snapshotting, so two resources writing one file must produce the
same string. Addresses are paths in 13 kinds and synthetic keys in the rest
(`defaults:<domain>`, `gsettings:<schema>:<key>`, `<manager>`). Those synthetic
ones are right — none names a file a user would manage as a file — but the engine
cannot tell a legitimately-synthetic address from one that should have been a
path. `Ai.McpServer` was the latter: it keyed on `ai-mcp-config:<tool>` while
writing `~/.claude.json`, so it shared no lock with a `Machine.File` on the same
path.

**Fix:** have a reconciler declare the real paths it writes, so this is
checkable rather than found by reading all 29 address implementations at once.

## Tier 1c — the architectural finding

Three separate audits, hunting three different things, converged on one shape.

**The architecture is sound. The abstractions fit. What is incoherent is that
this repo's hard-won disciplines live as prose and imitation rather than as
shared code.**

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

Against that, the same failure recurs three times:

| Discipline | Encoded where | Followed by |
|---|---|---|
| absent vs unreadable | prose + imitation | `ssh/Key`, `ssh/KnownHost`, `File`'s `stat` — but not `ManagedBlock`, `LineInFile`, `File`'s read, `Git.Repo`, `Codex` |
| read-after-write confirmation | prose + imitation | `System.Setting`, `System.Service` — not `Package`, `Repo`, `MacOS.Default` |
| collapse only verified exit codes | prose + imitation | `Git.Config`, `Grok` — not `SystemdUser`, `Launchd`, `Codex` |

Each was learned the expensive way — a container proving `gsettings set` lies, a
real `asdf` exiting non-zero while printing its answer — written into a doc
comment, and then not followed by the next package, because nothing made
following it easier than not following it.

**This is the highest-leverage fix in this document.** Not because any single
instance is the worst bug, but because it is the mechanism that generates them.
Three helpers in `core` — `readIfPresent`, `confirmWrite`, `exitCodeMeaning` —
would make the correct thing the short thing to write. Prose has now failed
three times; the next failure is already being written.

---

## Tier 1d — the framework models *what*, never *how the run behaves*

Every entry below is the same shape: a property of the **execution context**
that no type carries, so each backend improvises it, hardcodes it, or forgets
it. This is the largest structural finding in the document, and the individual
items are symptoms.

### 1d.1 Privilege is a hardcoded `sudo` at 16 call sites

`apt`, `dnf`, `pacman` and `snap` shell out to `Sh.sh("sudo", ...)`
unconditionally. `flatpak` does not, and nothing says whether that is a
deliberate user-scoped choice or an oversight.

Consequences, none of which a type would allow:

- **It runs `sudo` when already root.** Minimal containers frequently do not
  install `sudo`, so this fails with command-not-found in precisely the
  environments this repo verifies in. Our runs pass because they are root *and*
  happen to have it.
- **A password prompt has nowhere to go.** A non-interactive `deploy` hangs on
  the tty or fails. A reconciler that can hang mid-apply is worse than one that
  refuses to start.
- **A recipe cannot say** "already root", "use `doas`", or "no escalation
  available on this machine".

### 1d.2 Locale is never pinned — *every* parser is exposed

Zero occurrences of `LC_ALL` or `LANG` anywhere in `src`. This repo parses
human-readable output from `apt`, `dnf`, `pacman`, `brew`, `launchctl` and
more, all of which localise. **On a French or Japanese machine every parser in
the repo misreads**, and no test catches it because CI runs in English.

Same class as the winget ellipsis, except repo-wide and invisible.

### 1d.3 File ownership is not modelled at all

`mode` is handled meticulously — POSIX bits, a Windows ACL translation, a
`FilePermissions` type. `uid`/`gid` appear nowhere.

A file written under `sudo` is owned by root. `matches` compares mode only, so
it reports converged permanently while the user cannot read their own config.
The gap is invisible precisely because the neighbouring concept is so carefully
modelled.

### 1d.4 Timeouts are 57 hardcoded literals

Six distinct values (`"10 minutes"` ×17, `"15 minutes"` ×7, `"2 minutes"` ×6,
`"5 minutes"` ×4, `"1 minute"` ×2, `"30 seconds"` ×2), none configurable.

A slow link makes `brew install` exceed ten minutes and the deploy fails with no
recourse — the operator cannot raise it, and the number was chosen by whoever
wrote that backend. Timeout is a property of the run and the machine, not of the
package manager.

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

### 1d.8 The fix is one concept

An **`ExecutionContext`** threaded through the `exec` seam, carrying privilege,
locale, architecture, platform, and timeout policy — with each backend declaring
in its *type* what it requires, the way `VersionSpec` will declare what each
manager can honour.

`sudo` stops being a string. Locale stops being forgotten. Timeout stops being a
literal chosen by whoever wrote the file. And the recipe gains a way to say
things it currently cannot say at all: *this machine has no escalation*, *I am
already root*, *this link is slow*.

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

### 3b.2 Parent-directory creation, hand-written six times

`fs.makeDirectory(path.dirname(...), { recursive: true, ...mode })` appears
identically in `File.ts:134`, `ManagedBlock.ts:282`, `LineInFile.ts:286`,
`SecretFile.ts:154`, `KnownHost.ts:301`, `Key.ts:372`, in two textual variants.

`core`'s `Fs.ensureParentDir` already exists and only `Backups.ts` uses it.
Migrate the six.

### 3b.3 `directoryMode`, quantified

Seven resources each declare their own `directoryMode` prop
(`File.ts:36`, `ManagedBlock.ts:73`, `LineInFile.ts:82`, `Template.ts:128`,
`SecretFile.ts:31`, `KnownHost.ts:49`, `Key.ts:48`), and `DEFAULT_DIRECTORY_MODE
= 0o700` is redefined verbatim in three of them with the literal hardcoded a
fourth time in `Host.ts:96`.

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

### 4.1 A worktree build can be green and prove nothing

An agent working in a git worktree reported a clean `npm run build`, `npm test`
and `npm run lint` — and then disclosed that the worktree's `node_modules`
lacked the `@machine-run/*` symlinks, so bare specifiers resolved to the **main
checkout's stale copy** of the package it had just rewritten. Building the same
change on `main` broke five files immediately.

The disclosure was worth more than the refactor. The trap is silent by
construction: every command exits 0.

**Fix:** a preflight that asserts `node_modules/@machine-run/*` are symlinks
into the current checkout, run before `build`. Turn vigilance into a failed
command.

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
