# Tasks

The cross-cutting backlog. Work local to one package lives in that package's
own `TASKS.md`:

| Package | Backlog |
|---|---|
| `core` | [packages/core/TASKS.md](../packages/core/TASKS.md) |
| `engine` | [packages/engine/TASKS.md](../packages/engine/TASKS.md) |
| `machine` | [packages/machine/TASKS.md](../packages/machine/TASKS.md) |
| `dotfiles` | [packages/dotfiles/TASKS.md](../packages/dotfiles/TASKS.md) |
| `secrets` | [packages/secrets/TASKS.md](../packages/secrets/TASKS.md) |
| `system-packages` | [packages/system-packages/TASKS.md](../packages/system-packages/TASKS.md) |
| `system-services` | [packages/system-services/TASKS.md](../packages/system-services/TASKS.md) |
| `system-settings` | [packages/system-settings/TASKS.md](../packages/system-settings/TASKS.md) |
| `macos-defaults` | [packages/macos-defaults/TASKS.md](../packages/macos-defaults/TASKS.md) |
| `runtimes` | [packages/runtimes/TASKS.md](../packages/runtimes/TASKS.md) |
| `shell` | [packages/shell/TASKS.md](../packages/shell/TASKS.md) |
| `git` | [packages/git/TASKS.md](../packages/git/TASKS.md) |
| `ai` | [packages/ai/TASKS.md](../packages/ai/TASKS.md) |
| `tailscale` | [packages/tailscale/TASKS.md](../packages/tailscale/TASKS.md) |
| `ssh` | [packages/ssh/TASKS.md](../packages/ssh/TASKS.md) |

All fifteen have one. Six of the original fourteen did not exist until the inventory in
[MAP.md](./MAP.md) was written, which is how gaps in `ai`, `git`, `shell`, `ssh`,
`system-settings` and `tailscale` went untracked.

[MAP.md](./MAP.md) is the inventory — what exists, what is verified, what does
not exist yet. [V2-PLAN.md](./V2-PLAN.md) is the current priority order and
explains the blocker. [V1-PLAN.md](./V1-PLAN.md) is the first-principles coverage
map.
[SYSTEM-DESIGN.md](./SYSTEM-DESIGN.md) carries the reasoning behind decisions
referenced here. Completed work belongs in the design log, not accumulated here
as a changelog.

---

`plan`, `deploy`, drift detection and `destroy` all work —
`scripts/deploy-check.sh` runs the sequence in a container and passes. Seven
resource kinds have been through it (`Machine.File`, `ManagedBlock`, `Directory`,
`Symlink`, `SecretFile`, `Exec`, `System.Package`); the other sixteen have never
been deployed.

---

## P1 — debts that breadth created

Fourteen packages arrived faster than the invariants tying them together.

- [ ] **Eight resource-type naming conventions** — `Machine.*`, `System.*`,
      `MacOS.*`, `Tailscale.*`, `Git.*`, `Ai.*`, `Runtime.*`, `Shell.*`. The
      `Machine`/`System` split stopped meaning anything once both became
      reconcilers. **Not** a state-schema break, contrary to what this said
      before: Alchemy's `Resource(type, { aliases })` carries pre-rename type
      names, and `tryFindProviderByType` falls back to them — verified in
      `packages/engine/test/aliases.test.ts`. So this does not gate shipping;
      settle it after the first real `plan`/`deploy`, when there is evidence
      about which split actually reads well, and list every old name in
      `aliases`.
- [ ] **Two ways to express a directory** — `directoryMode` props on `File`,
      `ManagedBlock` and `SecretFile` versus `Machine.Directory`.
- [ ] **A README per package.** Source comments already reference ones that do
      not exist.

---

## P1 — Effect-native cleanup

All 25 `oxlint-plugin-effect` rules are enabled, **every override block is
gone**, and errors are at zero with `noAs` promoted to `error` — see
[LINTING.md](./LINTING.md) for the tier policy, the primitive each pattern
migrates toward, and the three inline exceptions that remain. The `warn` counts
are the backlog, currently 695 across seven rules:

- [ ] **`noNullish`** — 457, down from 531 with the `observe` migration. Much of
      the remainder is Alchemy's contract (`diff` returns `undefined`, attributes
      are JSON, optional props are `?`) rather than ours.
- [ ] **`noTernary`** — 160. The rule exists because Effect has better
      control-flow primitives, not because ternaries are ugly.
      `UndefinedOr.match`, `Boolean.match`, `Match`.
- [ ] **`noConditionalEmptyObjectSpread`** — 45. Centralise the omit-a-key
      pattern as one helper in `core`.
- [ ] **The tail** — `noNodeBuiltinImport` 16, `noRuntimeTypeof` 12,
      `noUnknownParameters` 3. Small enough to clear in one pass each.

---

## P1 — gaps the inventory surfaced

Writing [MAP.md](./MAP.md) meant checking claims instead of recalling them, and
these came out of it. None was tracked anywhere before.

- [ ] **Nine of twenty-three kinds still have no `unapply`.** Fourteen do.
      The nine are deliberate refusals in most cases, each with its reason
      recorded next to the resource: `Machine.Exec` (a command is not undoable),
      `Runtime.Tool` (nothing captures which version was active before),
      `MacOS.Default` (state never captures the prior value), `Ssh.Key`
      (deleting a private key is unrecoverable), `Git.Repo` (could destroy
      uncommitted work), `Tailscale.Connection` (could cut the operator's own
      access). What is left to decide is `System.Package`, `System.Repo` and
      `Machine.SecretFile` — the last needing a way to tell a file this resource
      wrote from one it adopted before deleting a credential is safe.
- [ ] **Alchemy primitives, audited — three still open.** Read each before
      deciding; the ones below were checked and the reasoning is recorded so it
      does not have to be redone.

      Nothing left open. The last two:
      - `Namespace` — `push("laptop", effect)` nests resource ids under a
        namespace, which is exactly the multi-machine scoping this list said was
        missing. It works on our resources unchanged (ambient context at
        registration, same as `renamedFrom`), so this was a documentation gap, not
        a code one — now written up in `packages/engine/README.md`.
      - `Action` — declined. An `Action` is an imperative one-shot: `Run: (input)
        => Effect`, no observe, no idempotence. `Machine.Exec` covers the same
        need as a *resource*, gated on `unless`/`creates`, so it converges instead
        of firing every deploy. For a machine reconciler an unguarded one-shot is
        an anti-feature — it is the non-convergence this tool exists to prevent —
        so the absence is the design, not an omission.

      Declined, with the reason:
      - `KeyPair` — its state is `{ privateKey: Redacted<string>, publicKey }`.
        Adopting it would put a private key in the state store, which is the one
        thing `Ssh.Key` exists to avoid (it shells to `ssh-keygen` and `stat`s
        rather than reads). Reuse would regress rule 8.
      - `PhysicalName` — generates a *unique new* cloud name from
        stack+id+stage+entropy. `address` names something that already has a
        name. Unrelated.
      - `Phase` — `"plan" | "runtime"`, distinguishing the deploy tool from a
        deployed artifact. Our observe/apply split is a type-level capability
        boundary, which is both a different question and stronger.
      - `Artifacts` for `Machine.Download` — this entry used to claim Download
        "rolls its own fetch-and-hash instead" of using it. Wrong: `Artifacts` is
        a per-FQN key/value cache, not an artifact fetcher.
      - `Artifacts.cached` for `PackageIndex` — it is FQN-scoped
        (`scopedArtifacts(fqn)`), one bag per resource instance, and
        `PackageIndex` exists precisely to share one `list` shell-out across
        *every* `System.Package` on a manager. Thirty apt packages would each get
        their own cache and shell out thirty times. `PackageIndex` also already
        reuses `effect/Cache` rather than a hand-rolled `Map`, for the
        concurrent-de-duplication reason its own doc comment gives — so this was
        reuse already, and my earlier note calling it hand-rolled was wrong.

- [ ] **`renamedFrom` is undocumented, and now matters more.** Alchemy's
      `Rename` module lets a recipe rename a resource's logical id without a
      destroy+create: `Dotfiles.File("new-id", {...}).pipe(renamedFrom("old-id"))`.
      It is fully wired in `Plan` and works on our resources unchanged — nothing
      in this repo mentions it. It matters more since `refuseUnowned` landed: a
      renamed `File` would otherwise plan a create, and the create now *refuses*
      because the file it finds is unowned. Document it, and test that a rename
      migrates the state row.
- [ ] **`@machine-run/ssh` has a `src/` and no `test/`** — the only package like
      that. Details in `packages/ssh/TASKS.md`.
- [ ] **The two least-verified seams are `secrets` (5 backends) and `ai` (12).**
      Between them that is 17 of the repo's 48 backend implementations that have
      never run against the real tool. `secrets` matters more: it writes
      `0o600` files, and `tailscale` depends on it, so its auth-key path is
      unverified twice over. `pass` in a container is the cheapest first
      conversion.
- [ ] **Nothing checks that a doc claim is still true.** Six task files were
      missing, four verification claims in prose were wrong, and a stale "sixteen
      packages" survived two package deletions. `ExampleCoverage.test.ts` shows
      the shape of the fix: a test that reads source and fails on a mismatch.
      Candidates worth the same treatment — the resource-kind count, the backend
      id lists, and every package having a `TASKS.md`.

---

## P1 — verification CI can now close

CI runs on `ubuntu`, `macos` and `windows` runners, which removed the last
"unreachable target" excuses. Every unchecked item below is a backend whose doc
comment still says *unverified*. The Windows runner type-checks only — see
"Windows" under P2 for the 16 tests that fail there and why.

- [x] **`winget export` instead of `winget list`.** Inventory now uses the
      real nested `Sources[].Packages[]` JSON shape through a typed temporary
      file capability; the old captured table parser remains only as a
      regression/diagnostic parser. Winget install behavior is still explicitly
      unverified on a Windows runner.
- [ ] nu's chdir hook *firing* (registration is verified; firing needs a TTY).
- [ ] `tailscale status --json`'s real shape.
- [ ] `Git.Signing` end to end — nothing in the repo signs anything yet.

---

## P1 — `Machine.EncryptedState`

**Recommended: build it.** Not because secrets are in state today — they are
not, and that rule must hold regardless — but because three things put material
there that nobody chose to put there.

The evidence, from Alchemy's own source rather than inference:

- `State/StateEncoding.ts` encodes `Redacted<T>` as
  `{ "__redacted__": <the actual string> }`, explicitly "so the actual string is
  persisted". **`Redacted` is log-redaction, not encryption at rest.**
- `Alchemy.KeyPair`'s state is `{privateKey: Redacted<string>, ...}` and its
  doc says the pair is persisted so deploys keep the same keys. Any Alchemy
  resource of that shape writes plaintext key material into `.alchemy/`.
- Alchemy's wider resource library (Cloudflare, AWS, Neon, Planetscale…) is
  full of API tokens. The moment one machine-run stack also manages a cloud
  resource — which is the whole point of it being an Alchemy stack — those
  tokens are plaintext on the machine's disk.

State also records vault references (`op://Personal/GitHub SSH Key/private
key`), paths and package lists. Individually dull; together a map of the
machine.

**Why this repo is unusually well placed to build it.** `StateService`
(`State/State.ts`) is a documented extension point — "third-party state stores
should pick a short, stable, kebab-case slug" — with a small interface (`id`,
`getVersion`, `listStacks`, `listStages`, `get`, `set`,
`getReplacedResources`). And the hard part of any encrypted store is *where the
key lives*, which machine-run already has an answer for: `@machine-run/secrets`
owns a `SecretBackend` seam whose `keychain` backend is exactly the right home
for a local encryption key. The key comes from the OS keychain through a seam
this repo already owns.

---

## P2 — remaining seams

Each follows the established shape: one interface, one module per
implementation, dispatched from inside one generic resource.

  - [ ] **Not folded into `@machine-run/machine`'s aggregate `providers()`**,
        by the deliberate scope boundary of the change that added the
        package (`packages/machine` was left untouched). `examples/complete-machine`
        works around this today by merging `SystemServices.providers()`
        directly into its stack's `providers:` field alongside
        `Machine.providers()` (see `alchemy.run.ts`) — which does type-check
        and would resolve for real, unlike a version that only *looked*
        wired up. Folding it into the aggregate itself is still the right
        end state, so every future recipe gets it for free: add
        `SystemServices.providers()` to `packages/machine/src/Providers.ts`'s
        `Layer.mergeAll` list, add `@machine-run/system-services` to that
        package's `dependencies`, add `packages/system-services` to its
        `tsconfig.json` `references` — the three edits that file's own doc
        comment already calls for.
- [ ] **Manifest resources** — `Brew.Bundle`, `Mise.Toml`,
      `Asdf.ToolVersions`, `Nix.Flake`. Atomic and manifest layers are
      complementary (V1-PLAN §3), but a manifest resource must refuse to
      co-manage a manager the atomic layer is also managing.
- [ ] **`ssh` breadth** — `Ssh.KnownHost`, `Ssh.Key` (generate via Alchemy's
      `KeyPair` or materialise from a vault), agent configuration.
- [ ] **Windows** — `Platform` service in `core`, registry `SettingsBackend`,
      `bootstrap.ps1`, and an audit of path handling for `/` assumptions.

      The repo now **type-checks** on Windows (`typecheck (windows)` in CI) but
      the test suite does not pass there: 16 tests across 7 files fail, for
      three distinct reasons. This is the concrete work list.

      *Platform truth — POSIX modes are not representable.* Node reports `0o666`
      (`438`) for every file on Windows and `chmod` only toggles the read-only
      bit, so a pinned `mode` can never be observed back and `matches` reports
      drift forever. Affects `Directory` (4), `File` (2), `SecretFile` (3),
      `Download` (1). **Researched and designed** —
      [docs/notes/windows-permissions.md](./notes/windows-permissions.md) is
      the full evidence trail (Node/libuv source, Microsoft's own `icacls` and
      well-known-SID docs, a real captured `icacls` transcript) and the
      decision: translate `mode` → an ACL *intent* on apply, and compare
      "granted no broader than `mode` allows" (not exact equality) on observe,
      via a `FilePermissions` domain type in `core`. **Built and unit-tested,
      not yet wired in**: `packages/core/src/windows/{FilePermissions,
      Icacls}.ts` is the pure translation and the `icacls`-output parser,
      pinned by `packages/core/test/windows/*.test.ts` and — once a Windows CI
      run has actually exercised it — `IcaclsLive.test.ts` (`verify-windows`
      in `.github/workflows/ci.yml`). None of `Directory`/`File`/`SecretFile`/
      `Download` calls into it yet; the notes doc's §7 lists exactly what that
      follow-up change needs (a `Platform` service, each resource's
      `observe`/`apply` branching to the `icacls` path on Windows, and a
      decision on the `isNoBroaderThan` comparison's known asymmetry — it
      cannot detect a principal granted *fewer* rights than `mode` allows).

      *Platform truth — `chmod 0o000` does not make a directory unreadable.*
      Three tests build an unreadable-parent fixture that way to prove
      `observe` raises a typed error instead of reporting absence. The
      invariant is right; the fixture cannot express it on Windows. Affects
      `File`, `SecretFile`, `Symlink`.

      *Was a real bug — **fixed**.* `packages/engine/test/unapply.test.ts` →
      "unapply restores the pre-existing content it backed up on adoption"
      failed because `output.backupPath` was `undefined`. Root cause found by
      reading `Backups.ts` rather than by reproducing on Windows: the backup
      destination mirrored the source path verbatim, so a Windows path became a
      directory segment literally named `C:`. `:` is forbidden in a Windows path
      segment, so `makeDirectory` failed, the failure was logged rather than
      raised (correct — a backup must not abort a deploy), and the overwrite
      proceeded **with no backup**: the one outcome the service exists to
      prevent, arrived at silently. `mirrorSegments` now rewrites the drive as
      an ordinary segment (`C:\Users\me` → `C/Users/me`) and prefixes UNC paths
      with `UNC` so `\\server\share` cannot collide with a local
      `server/share`. Pinned by `packages/core/test/Backups.test.ts`.

      *Also unverified on Windows:* `git clone`/`remote` behaviour — three
      `Git.Repo` `apply` tests fail and the cause has not been read yet.

**Breadth before depth is the standing risk.** `deploy-check.sh` exercises 7 of
23 kinds; the other 16 have an `observe`/`apply` the engine has still never run.

---

## P3 — operations & release

- [ ] **Doctor / drift report** — answer "what no longer matches" without
      applying. Meaningful now that `diff` observes live state.
- [ ] **Import an existing machine** — implement `list` on `System.Package`.
- [ ] **Finish the unmanage story** — the mechanism exists and two resources
      implement `unapply`; which of the remaining ~18 can honestly reverse
      themselves is still open (V1-PLAN §5).
- [ ] **License.** `UNLICENSED` with no `LICENSE` file blocks any release.
- [ ] **Nine high-severity advisories, none of them reachable — decide what to
      say about it.** `npm audit` reports 9 high and 5 moderate; GitHub counts 43
      across the default branch. Every one is transitive, and every one arrives
      through `alchemy`'s own hard `dependencies` — `@alchemy.run/cloudflare-runtime`
      (→ `@puppeteer/browsers` → `extract-zip`, unvalidated symlink path
      traversal) and `@prisma/dev` (→ `hono`, `@hono/node-server` authorization
      bypass), plus `sharp`'s libvips CVEs and `lodash`'s `_.template` code
      injection. Neither is optional or peer, so they cannot be dropped from the
      tree.

      They are also not reachable from this repo. Checked statically rather than
      asserted: the twenty alchemy modules that import any of them are all under
      `lib/Cloudflare/` or `lib/Prisma/`, and machine-run imports neither
      subtree (nor `sharp`, `hono`, `puppeteer` or `lodash` directly — the only
      source matches for those names are the words "honoured" and "sharpest" in
      two doc comments).

      So this is a reporting problem rather than an exposure, and the fix is not
      ours to make: upstream would have to move those to optional deps. What
      needs deciding before publishing is what consumers are told, since they
      will see the advisories on install. `overrides` are ruled out by the
      max-type-safety/no-overrides rule and would in any case be forcing
      versions inside puppeteer's own tree. The patch set is a third option —
      it already patches alchemy — but dropping a hard dependency there breaks
      alchemy's Cloudflare paths for anyone who does use them, so it is a real
      decision and not a cleanup.
- [ ] **Publishing** — versioning policy, and validate the `exports` maps
      resolve for a real non-workspace consumer. Only ever exercised inside
      this workspace.
- [ ] **A `machines-<you>` template repo.** The repo split is the intended
      usage and nothing demonstrates it.
