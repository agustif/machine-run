# MUST_CLEANUP

Code smells and anti-patterns in this repo, with the evidence for each.

**The bar for an entry here:** a file and line, a reason, and a cost. Not a
feeling. An entry that cannot name where it lives does not belong, because the
cost of a false positive is somebody "fixing" working code — and this repo has
already had one near miss, where a mechanical scan for unused exports flagged
error classes that exist precisely to be matched on by consumers.

**The bar for removing an entry:** the smell is gone, not renamed.

Ordered by what it costs, not by how easy it is. [TASKS.md](./docs/TASKS.md) is
the work backlog; this is the list of things that are *wrong* rather than
missing. Where they overlap, this file explains why and TASKS.md tracks the doing.

---

## Tier 1 — costs correctness

### 1.1 `list` is stubbed to empty at the engine seam

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

---

## Tier 2 — design drift

### 2.1 `ProviderOverrides` is dead code

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
- **`as` in `packages/cli/src/Commands.ts`** — one narrowing, named
  (`withoutEvalStackInternals`), bounded to exactly the two services `evalStack`
  provides internally, so a third requirement appearing later is a compile error
  rather than being silently absorbed.
