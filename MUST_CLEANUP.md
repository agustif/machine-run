# MUST_CLEANUP

Code smells and anti-patterns in this repo, with the evidence for each.

**The bar for an entry here:** a file and line, a reason, and a cost. Not a
feeling. An entry that cannot name where it lives does not belong, because the
cost of a false positive is somebody "fixing" working code — and this repo has
already had one near miss, where a mechanical scan for unused exports flagged
error classes that exist precisely to be matched on by consumers.

**The bar for removing an entry:** the smell is gone, not renamed.

**Provenance.** Entries marked *verified* were re-read line by line while
writing this. The rest come from a three-part audit and carry file and line but
were not independently re-read — the distinction is kept because publishing
someone else's confidence as your own is how a document like this rots.

Ordered by what it costs, not by how easy it is. [TASKS.md](./docs/TASKS.md) is
the work backlog; this is the list of things that are *wrong* rather than
missing. Where they overlap, this file explains why and TASKS.md tracks the doing.

---

## Tier 0 — data loss, verified

These destroy data that cannot be recovered. Each was re-read line by line
before being written down here.

### 0.1 A locked keychain silently destroys every encrypted state row

> **FIXED.** `SecretNotFound` is now a distinct error, recognised from exit 44 *and* the specific stderr together, and `ensureDataKey` mints on that tag alone. Measured rather than assumed — and a locked keychain turned out to return no programmatic error at all, blocking on an interactive prompt instead, so the dangerous cases are the headless "user interaction is not allowed" and transient failures.

`packages/state/src/DataKey.ts:136-147`.

`ensureDataKey` wraps `readDataKey` in `Effect.catch(() => ...)` — catching
*every* failure — and responds by minting a fresh random key and persisting it
with `security add-generic-password -U`, which updates in place.

`readDataKey` folds every `SecretError` into one `DataKeyUnavailable`, so
"there is no key yet" and "the keychain is locked", "user interaction is not
allowed" (the headless case), or "`security` was momentarily busy" are
indistinguishable at the catch. A transient read failure therefore **overwrites
the real key**. Every row already encrypted under it becomes permanently
undecryptable, and `EncryptedState.get` degrades that to `undefined` with a log
warning — so the next plan reads the whole machine as unmanaged.

The tests cover the entry being deleted and the ciphertext being tampered with.
They do not cover a read failing while the entry still exists, which is the case
that loses the data.

**Fix:** only mint on a genuine absent signal. The keychain backend needs a
distinct "no such entry" case rather than folding it into a general read
failure — the same distinction `isNotFound` already draws for the filesystem.

### 0.2 `ManagedBlock` can overwrite a file it does not own

> **FIXED.** Now uses `core`'s `readIfPresent`, with a typed `ManagedBlockFileUnreadable`. Test verified to fail without the fix.

`packages/dotfiles/src/ManagedBlock.ts:247-248` — `readFileOrEmpty` is
`fs.readFileString(target).pipe(Effect.orElseSucceed(() => ""))`, used by both
`observe` and `apply`.

Any read failure becomes "the file is empty". `ManagedBlock` exists precisely
for files this tool does *not* own outright — `~/.zshrc`, `~/.gitconfig`,
`~/.ssh/config` — so a permission change or I/O error makes `apply` write just
the marker block over somebody's hand-written shell config.

`snapshotBeforeApply` is set, but it only fires on adoption (`output === undefined
|| olds === undefined`). On an ordinary re-apply of an already-managed file there
is no backup, which is exactly when this fires.

**Fix:** the `stat` + `isNotFound` pattern from `File.ts:94-102`.

### 0.3 `LineInFile` has the same bug

> **FIXED.** Same, with `LineInFileUnreadable`.

`packages/dotfiles/src/LineInFile.ts:233-234`. Identical mechanism, identical
consequence, on files like `/etc/hosts`. Same fix.

### 0.4 `File` throws away its own discipline one line later

> **FIXED.** The read now carries the same discipline as the `stat` above it.

`packages/dotfiles/src/File.ts:104`.

The sharpest illustration in the repo. Lines 94-102 do the careful thing: `stat`,
and raise `FilePathUnreadable` for anything that is not a not-found. Line 104
then reads the file with `Effect.orElseSucceed(() => "")`, discarding it. A
permission change between the two, or any read error, reads as empty content →
drift → overwrite.

Lower practical severity than 0.2 because `File` owns its content outright, but
it is the same bug, and the doc comment fifteen lines above describes this exact
failure mode as the thing being prevented.

**Fix:** same `catchTag` + `isNotFound` treatment as the `stat` two lines up.
`Template` inherits the fix for free through `makeFileReconciler`.

### 0.6 A prop is interpolated raw into a shell command — *verified*

> **FIXED.** `Sh.sh("gh", "auth", "switch", "--user", ghAccount)`, with a test that spawns a real shell against a stubbed `gh` and a companion guard proving the old form *does* execute the injection.

`packages/git/src/Identity.ts:149`:

```ts
command: `gh auth switch --user ${ghAccount} >/dev/null 2>&1`
```

`ghAccount` is a caller-supplied prop, interpolated without `Sh.quote`. This
contradicts the repo's own rule that shell commands go through `Sh`, and it is
worse than a normal injection site because the result is **written into a shell
rc file** and re-executed on every directory change — a value containing `;` or
a space becomes a permanent hazard in the operator's own `.zshrc`, not a
one-shot failure.

The blast radius is limited: it is the operator's own recipe, so this is
self-inflicted rather than a remote attack. It is still a bug, and it is exactly
the bug a type could have prevented — see 2.5.

**Fix:** `Sh.sh("gh", "auth", "switch", "--user", ghAccount)` plus the
redirection appended as a literal.

### 0.7 `security -w` silently hex-encodes any secret with a non-printable byte

`packages/secrets/src/backends/Keychain.ts` — verified on real macOS.

`security find-generic-password -w` returns the **ASCII-hex encoding of the
stored bytes rather than the bytes** whenever the value contains a byte outside
`isprint()`. Exit 0, no warning, nothing in stderr. A value with embedded
newlines came back as `6c696e65310a6c696e65320a6c696e6533`; a value with a
single tab behaved identically.

This corrupts exactly what `Machine.SecretFile` exists to place: an SSH private
key and a PEM certificate are multi-line by definition, so either would be
written to `~/.ssh` as hex text. OpenSSH would then reject it as an invalid
format — the failure at least being loud, though only at use time, long after
the deploy reported success.

`-g` disambiguates where `-w` cannot: it prints `password: 0x<hex>` for the
raw-byte fallback and `password: "quoted"` for the printable case.

Pinned as a `BUG:` test rather than fixed, so the behaviour is recorded and the
fix has a failing test waiting for it.

**Fix:** read with `-g` and parse both forms.

### 0.8 Credentials written world-readable — *fixed, with the measurements*

`packages/ai/src/backends/{Claude,OpenCode}.ts`, plus a narrower window in
`packages/dotfiles/src/{Download,File}.ts`.

Three facts, each measured on this machine rather than assumed, because every
one of them is the opposite of what the API's shape suggests:

| Measured | Result | Consequence |
| --- | --- | --- |
| `writeFileString(p, c)` with no mode | **0644** | at umask 022, world-readable |
| `writeFileString(p, c, {mode: 0o600})` on an **existing** 0644 file | **stays 0644** | mode applies only on *create*; chmod is still required, or a reconciler observing mode never converges |
| `makeTempFile()` | **0644** | not the 0600 the name suggests |
| `chmod(p, 0o400)` then write, as the owner | **EACCES** | the owner is not exempt from their own permission bits |

Against those: both AI backends wrote their config with **no mode and no
chmod** — so 0644, in a 0755 directory. That file is a credential store *by
design*: `mcpServers[].env` and `headers` are typed to accept
`Redacted<string>`, so the API key of every registered MCP server was
world-readable on every machine this ever ran on. `SecretFile` had derived the
correct pair on its own — and its comment states exactly what the second row
above measures — but the discipline lived in one file instead of a shared one.

`Download` additionally carried a comment claiming the file "never exists, even
momentarily, with the wrong permissions", which row three falsifies: its temp
file is created 0644 *in the target's own directory* and only restricted after
the bytes are in it. `File` had the same write-then-chmod window, without the
false claim.

**Fixed:** `Fs.writeCredentialFileString` in core now encodes both halves
(mode on create *and* chmod after) with the measurements in its doc comment,
and both AI backends use it with a 0700 directory. `Download` restricts its
temp file to 0600 *before* the write and applies `props.mode` after — 0600
rather than the final mode precisely because of row four, and conditional on
`props.mode` being set so an unmoded download is not quietly tightened.

Regression tests assert both directions per backend (fresh file, and a file
another tool already created 0644), the read-only `mode: 0o444` download that
row four would have broken, and that an unmoded download keeps the platform
default.

### 0.5 The pattern behind 0.1–0.4

These are one architectural problem wearing four faces: **the repo has a house
rule for telling "absent" from "unreadable", and nothing makes following it
easier than not.**

`ssh/src/Key.ts` and `ssh/src/KnownHost.ts` are the gold standard;
`File.ts`'s `stat` is correct and its read is not. The discipline lives in prose
and in imitation, so each new resource re-derives it — and `ManagedBlock`,
`LineInFile`, `Git.Repo` and `Codex` each got it wrong in a different place.

**Fix that actually closes it:** put the pattern in `core` as a named helper
(`readIfPresent`, `statIfPresent`) that returns "absent" only for a real
not-found and raises otherwise. Then the correct thing is the short thing to
write. A lint rule cannot express this; a helper can.

## Tier 1 — costs correctness

### 1.1 `list` is stubbed to empty at the engine seam

> **FIXED.** `Reconciler.list` is optional and passed through; no resource implements it yet, which is now an explicit absence rather than the adapter's decision.

`packages/engine/src/toProvider.ts:179` — `list: () => Effect.succeed([])`, for
all 23 resources.

Alchemy models `list` as a real provider capability. Every resource this repo
defines returns "there is nothing" instead, which is not true and is not
knowable from an empty array by any caller.

The cost is concrete rather than theoretical: `packages/system-packages/TASKS.md`
carries "**Implement `list`** so an existing machine can be inventoried into a
recipe" — a capability the adapter currently makes unreachable, because a
resource has nowhere to put its implementation. `System.Package` genuinely can
enumerate (`brew list` is right there); the seam is what blocks it.

**Fix:** let a `Reconciler` optionally provide `list`, and pass it through.
Resources that cannot enumerate keep returning empty *explicitly*, which is a
different statement from the adapter deciding for them.

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

### 1d.1 Privilege is a string prefix in 4 of 19 backends

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

### 1d.4 Timeouts are 38 hardcoded literals

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

### 2.1 `ProviderOverrides` is dead code

> **FIXED.** Deleted. Alchemy's `Provider.effect` already defaults a missing `list` to an empty array, so omitting the key is behaviourally identical to the stub — but the claim now belongs to whoever decided it.

`packages/engine/src/toProvider.ts:20` defines it; line 157 accepts it. **Zero
of the 23 `toProvider` call sites pass it.** It is referenced nowhere else in
`src` or `test`.

Worth stating plainly because I got this wrong out loud before measuring it: I
described this escape hatch as evidence that the `Reconciler` abstraction could
not express Alchemy's real contract. The measurement says the opposite. An
abstraction that 23 of 23 consumers use *without ever needing to escape* is a
well-fitting abstraction, and the parameter is speculative generality that was
never needed.

**Fix:** delete `ProviderOverrides` and the third parameter. Anything genuinely
needing `version`/`stables`/`precreate` can call `Provider.effect` directly,
which the doc comment already says.


### 2.5 `Sh` returns `string`, so quoting is a convention rather than a type

> **FIXED.** `ExecProps` (`engine/src/Reconciler.ts`) and `state/src/DataKey.ts`'s
> local `Exec` now require `command: Sh.ShellCommand` instead of `string`, so a raw
> template literal no longer compiles at the one place every reconciler actually
> runs a command. Every non-`Sh.sh`/`Sh.pwsh` site the compiler then rejected was
> resolved as one of: routed through `Sh.sh` (the fixed literal commands with no
> untrusted interpolation — `brew list --formula --full-name` and its many
> siblings across `system-packages`/`runtimes`/`tailscale`), or `Sh.unsafeRaw`
> with a named reason. `Machine.Exec` and `Ai.McpServer` are the two escape
> hatches this entry already named; three more turned up in the doing and are now
> named too: a fixed multi-statement shell script (`;`, an unquoted glob, command
> substitution) that argv-quoting cannot represent at all (`Go.ts`'s `list`,
> `Npm.ts`'s `list`, `Apt.ts`'s `listRepos`), a command that must reference an
> env var via `"$VAR"` for secrecy — `Sh.sh` would single-quote the `$` and
> suppress the very expansion needed (`Tailscale.Connection`, `DataKey.persistDataKey`),
> and gluing two already-safe `ShellCommand`s into one pipeline, now `Sh.pipe`
> (`macos-defaults/src/Default.ts`'s `defaults export | plutil -extract`, the
> case this entry's own fix note anticipated). None of these three are the
> accidental kind 0.6 found — each is a real command shape `Sh.sh`'s per-argument
> quoting cannot express, not a value that needed quoting and didn't get it.

`Sh.sh()` and `Sh.pwsh()` exist to make shell interpolation safe, and return a
bare `string` — indistinguishable from an unquoted one. Nothing stops
`command: \`...${x}...\``, and 0.6 is that gap being taken.

Of 190 `command:` sites, 107 go through `Sh`. Most of the rest are legitimate:
`Machine.Exec` runs arbitrary shell *by design*, and `Ai.McpServer` launches a
user-named binary. The problem is that the deliberate escape hatches and the
accidental one look identical.

**Fix:** brand the return of `Sh.sh`/`Sh.pwsh` (`ShellCommand`), require it at
`exec({ command })`, and give the escape hatches an explicit
`Sh.unsafeRaw(reason)`. Raw interpolation then stops compiling, and every
remaining unsafe site has to say so out loud. The 107 compliant sites migrate for
free; the ~20 that do not are precisely the list worth reviewing.

### 2.6 Versions are spelled four ways and pinning is not a concept

Eleven declaration sites, four vocabularies, no shared meaning:

| Spelling | Where | What it really is |
|---|---|---|
| `version: Schema.String` | `runtimes` mise/asdf/uv (×6), `Runtime.Tool` state | a *range* — `"22"` is satisfied by any 22.x, per `versionSatisfies` |
| `channel: Schema.String` | `runtimes` rustup | not a version at all; `stable`/`nightly` — discovered only by running rustup |
| `checksum: Schema.String` | `Machine.Download` | content-addressed pinning, the strongest form |
| `branch` | `Git.Repo` | a moving ref — "latest" wearing a different word |
| *nothing* | `System.Package`, `System.Repo` | every install means whatever is latest today |

`packages/runtimes/src/version.ts` already implements matching semantics
(`versionSatisfies`) that nothing outside `runtimes` reuses, so any future
version comparison will be written a fifth time.

**The cost is reproducibility, which is the product.** `System.Package` cannot
pin, and `matches` compares presence only — so a package that moved three major
versions still reports converged, and `plan` says nothing changed. A recipe that
cannot reproduce a machine is running an installer, not reconciling.

It also produces concrete failures that get misdiagnosed. `Go.ts` carries a long
comment explaining why `go install pkg@latest` failing on a toolchain floor
"cannot be helped" — it can: the resource simply has no way to say which version
it wants.

**The idea that makes this a framework concept rather than a field:** *`latest`
is not a version, it is a policy.* It means "re-resolve on every run", which
makes a resource non-reproducible by construction. Today that is the silent
default for every package. It should be something a recipe says out loud and a
plan can show.

**Fix:** a `VersionSpec` tagged union in `core` — `Exact`, `AtLeast`, `Channel`,
`Latest`, `Digest` — with each backend declaring in its *type* which forms it
can honour, since `snap` takes channels, `mas` takes an App Store id, and
several managers can pin at install but cannot downgrade. A backend that
silently ignores a pin is the same bug class as everything else in this
document.

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
`Tailscale.*`, `Ssh.*`.

`Machine.SecretFile` lives in `secrets`; `Machine.File` in `dotfiles`;
`System.Package` in `system-packages` but `System.Setting` in `system-settings`
and `System.Service` in `system-services`. The `Machine`/`System` split tracks
nothing a reader can predict.

Deferred deliberately, not forgotten: a rename is a state-schema break, and
doing it before the engine has ever run risks renaming to a second wrong thing.
The cost of waiting is that every new resource picks a namespace by imitation.

**Fix:** settle it immediately after the first successful `plan`/`deploy`.

### 2.4 `observe` returns `State | undefined`

Every reconciler. `undefined` means "not there", which Effect models as
`Option`. This is the single largest contributor to the `noNullish` count below.

**Fix:** written up as one atomic change in `packages/engine/TASKS.md`.

---

## Tier 3 — consistency and hygiene

### 3.1 873 lint warnings

All 25 `oxlint-plugin-effect` rules are enabled and **errors are at zero**;
these are the `warn` tier, and they have grown with every package.

| Rule | Count | What it means here |
|---|---:|---|
| `noNullish` | 516 | mostly `observe`'s `undefined` (2.4) plus Alchemy's own optional-prop contract |
| `noTernary` | 180 | Effect has `Match`, `UndefinedOr.match`, `Boolean.match` |
| `noAs` | 91 | see 3.2 |
| `noConditionalEmptyObjectSpread` | 55 | the omit-a-key pattern, uncentralised |
| `noRuntimeTypeof` | 14 | should be `Schema` at a boundary |
| `noNodeBuiltinImport` | 13 | should be Effect platform services |
| `noUnknownParameters` | 4 | |

Concentrated in `ai` (217), `dotfiles` (125) and `runtimes` (113).

### 3.2 `noAs` is a warning, and it has been hiding real bugs

91 occurrences. This tier is not cosmetic: removing **one** `as never` at the
engine seam exposed genuine unsoundness — the reconciler's `State` was never
tied to the resource's declared `Attributes`, so a reconciler could return state
its resource had never declared, and `output` from a previous run was typed as
the narrower state when Alchemy hands back attributes.

Two `as unknown as` also remain in `packages/state/src`.

**Fix:** promote `noAs` to `error` and clear the 91. Expect some of them to
expose modelling holes rather than needing a cast.

### 3.3 No package has a README

**17 of 17.** Source doc comments already reference READMEs that do not exist —
`macos-defaults`' capture workflow and `ai`'s vault-directory setup are both
pointed at from code.

---

## Tier 3b — duplication, counted

From the duplication audit; the first entry re-verified while writing this.

### 3b.1 `isNotFound` is exported by `core` and reinvented three times — *verified*

> **FIXED.** The three private copies are gone.

`packages/core/src/Paths.ts:73` exports it. `dotfiles/src/Directory.ts:85`,
`Download.ts:142` and `Symlink.ts:71` each define a byte-identical private copy.

The cheapest fix in this document — delete three lines, extend an existing
import — and the most telling, because this is the very predicate the Tier 0
bugs are about. The discipline of 0.5 has a helper already; three files did not
find it and wrote their own instead. That is the mechanism, caught in the act.

### 3b.2 Parent-directory creation, hand-written six times

`fs.makeDirectory(path.dirname(...), { recursive: true, ...mode })` appears
identically in `File.ts:134`, `ManagedBlock.ts:282`, `LineInFile.ts:286`,
`SecretFile.ts:154`, `KnownHost.ts:301`, `Key.ts:372`, in two textual variants.

`Template.ts` does **not** duplicate it — it delegates to `makeFileReconciler`,
which is the pattern the other six should have followed. One file already proves
it is fixable. Extract `ensureParentDir(fs, path, mode)` into `core`.

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

### 3b.5 `Number(info.mode) & 0o777` — seven times — *verified*

Across `Directory.ts`, `File.ts`, `Download.ts`, `SecretFile.ts`. An unclaimed
`posixMode(info)` helper that four files independently reinvented.

### 3b.6 `fakeExec` copied into seven test files

Identical four-line helper in `runtimes`, `system-packages` (×2),
`system-services`, `system-settings` (×2) and `secrets` tests. If `Exec`'s result
shape gains a field, seven files need the same edit. `git`'s variants genuinely
differ (they model exit codes) and should stay.

### 3b.7 `core/src/windows/` has zero callers

`FilePermissions.ts` and `Icacls.ts` — 494 lines with three test files and **no
consumer in any of the 16 resource packages**. It is honestly labelled as a
prototype in `docs/MAP.md`, so it is not hidden. But nothing forces it to stay
correct, and if the real Windows integration needs a different shape, this has
had no pressure to match it. Wire it up or delete it; do not let it age.

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

### 4.2 Tests passing does not mean it compiles

After one merge, 526 tests passed while `tsc -b` failed. Vitest transpiles
without type-checking, so a type error is invisible to the test suite. The cause
was itself a real bug in a guard: `@ts-expect-error` suppresses only the *next*
line, and the object literal it guarded spanned several, so the error landed
outside its scope and the guard proved nothing.

**Fix:** never read a green test run as a green build. CI already runs both;
the habit is what needs fixing.

---

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
