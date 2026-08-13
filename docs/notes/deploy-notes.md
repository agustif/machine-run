# Deploy notes

The record of actually running this repo, for the first time, against a real
(if throwaway) machine — see `docs/TASKS.md` P0 and `scripts/deploy-check.sh`.
Every claim below was observed by running the command shown, not inferred
from reading source.

Format: what was run, what happened, and — for anything that broke — a
diagnosis of whose bug it is (this repo's, Alchemy's, or the harness's) so a
later reader doesn't have to re-derive it.

This work happened while six other agents were actively editing `packages/*`
in the same working tree (a new `@machine-run/machine` aggregate-providers
package landed mid-session, `Reconciler`'s shape was being touched, a
`system-settings` package and `tailscale` tests were mid-flight). Where a
build/test failure traced back to that concurrent work rather than anything
in `docker/`, `scripts/`, or the example recipe, it's noted as such and not
"fixed" here — packages/* is out of this task's scope. `examples/example-machine`
and its own project (`npx tsc -b examples/example-machine`) stayed green the
whole time; the root `npm run check` (`tsc -b` across every package,
including in-flight ones) did not, at various points, for reasons unrelated
to this work.

## Findings, in the order they were hit

### 1. `examples/example-machine` pinned a second, mismatched `alchemy`/`effect`

**Command:** `cat examples/example-machine/package.json` (then confirmed via
`npm install` producing a *second* `node_modules/alchemy` nested inside
`examples/example-machine/`, at `2.0.0-beta.67`, while the workspace root — and
every `@machine-run/*` package's peerDependencies — used `2.0.0-beta.72`).

**Diagnosis: a real bug in this repo.** The example recipe's own
`package.json` declared `"alchemy": "2.0.0-beta.67"` and
`"effect": "4.0.0-beta.102"`, both stale relative to the rest of the
workspace. The root `package.json`'s `overrides` forces `effect` to one
version repo-wide, which is why only `effect` deduped correctly; `alchemy` has
no such override, so npm installed a second, incompatible copy just for this
one package. Alchemy's `Resource`/`Provider` machinery is built on classes
constructed by the specific `alchemy` module instance that defines them
(`Resource<File>("Machine.File")` is `instanceof`-sensitive), so a recipe
importing a *different* `alchemy` instance than the one every `@machine-run/*`
package's `Provider`s were built against is a real dual-package hazard, not
just wasted disk space — plausibly the reason nothing here had ever actually
been run.

**Fix applied:** pinned `examples/example-machine/package.json` to the same
`alchemy`/`effect` versions as the rest of the workspace.

### 2. `npm run check`'s `tsc -b` intermittently failed for reasons outside this task's scope

**Command:** `npm run check` (root).

**Observed (at various points during this session):** `TS6307` from
`packages/machine` not being listed in `tsconfig.tests.json`'s references; a
`Reconciler.observe` return-type mismatch (`T | undefined` vs. an `Option`)
across `dotfiles`/`macos-defaults`/`secrets`/`system-packages`/`tailscale`
simultaneously.

**Diagnosis: concurrent work-in-progress in `packages/*`, not this task's bug,
and not persistent.** Both symptoms disappeared on a later recheck once the
concurrent edits landed — the second one in particular could only be
transient, since `packages/engine/src/Reconciler.ts` read on disk (checked
directly) never actually declared an `Option`-returning `observe` at any
point this was investigated. Root `tsconfig.json`/`package.json` are outside
this task's scope to fix regardless. **Decoupled the container deploy from
this:** `scripts/deploy-check.sh` builds only `examples/example-machine`'s own
project (`tsc -b examples/example-machine`, which pulls in exactly the
packages the recipe imports via project references) rather than depending on
the whole monorepo's `tsc -b` succeeding first. That project stayed green
throughout.

### 3. `docker build`: `npm install` as a non-root user failed with `EACCES`

**Command:** `docker build -f docker/Dockerfile -t machine-run-deploy-check .`

**Observed:**
```
npm error code EACCES
npm error syscall mkdir
npm error path /workspace/node_modules
npm error Error: EACCES: permission denied, mkdir '/workspace/node_modules'
```

**Diagnosis: a harness bug (this repo's `docker/Dockerfile`, not Alchemy or
npm).** `COPY --chown=runner:runner . .` only sets ownership on the files it
creates, not on the destination directory itself — `/workspace` was created
earlier by `WORKDIR /workspace` while still root, so it stayed root-owned.
Switching to `USER runner` before `npm install` then failed to create
`node_modules` in a directory it couldn't write to.

**Fix applied:** added `RUN chown runner:runner /workspace` (as root, right
after the `COPY`) before the `USER runner` switch.

### 4. `docker build`: ran out of disk space during image export, twice

**Command:** `docker build -f docker/Dockerfile -t machine-run-deploy-check .`

**Observed:** `failed to extract layer ...: no space left on device`, then
(after freeing some space) `failed to write compressed diff: ... no space
left on device` during the "exporting to image" step specifically.

**Diagnosis: harness/environment, not this repo's code.** This sandbox's
OrbStack VM disk is small (~7.7–8.1GB) and shared with whatever other agents
in this session are doing concurrently in Docker (their images —
`archlinux`, `fedora`, `powershell`, `pgvector`, `ubuntu:24.04` — were already
present and were **not** touched). The macOS host itself was also down to
~1.3GB free. Not a finding about machine-run; recorded because it's the kind
of thing that makes a "first-ever deploy" flaky for reasons that have nothing
to do with the code being deployed.

**Mitigation, not a fix:** freed host disk (deleted a scratch copy of the
repo this session had made for isolated experimentation, unrelated to any
other agent's files) and ran `docker builder prune -f` (build cache only —
never touched another agent's images or the one running container found via
`docker ps -a` mid-session). Re-ran the build after freeing space.

### 5. The container image never built this repo's TypeScript — `Cannot find module '.../lib/index.js'`

**Command:** `docker run --rm machine-run-deploy-check:latest` (first
successful image build, before this fix).

**Observed:**
```
Error: Cannot find module '/workspace/node_modules/@machine-run/dotfiles/lib/index.js'
imported from /workspace/examples/example-machine/alchemy.container.ts
```
at the very first `alchemy plan`.

**Diagnosis: a harness bug.** Every `@machine-run/*` package's `package.json`
`"import"` export condition points at `./lib/index.js` — there is no
runtime fallback to `./src` under plain `node` (only the `"bun"` condition
points there, and this image runs under `node`, per the task). `docker/Dockerfile`
ran `npm install` but never a build, so `lib/` never existed inside the
image. This is the actual first-ever attempt to *run* (not just type-check)
this repo's engine against a resource, and it failed before reaching a
single `yield*` in the recipe — i.e., before machine-run's own logic ever
executed at all.

**Fix applied (superseded, see below):** added `RUN npx tsc -b examples/example-machine`
to the Dockerfile, after `npm install`.

**Update:** even scoped to just this one project, building *inside* the
image was still fragile — a later, unrelated concurrent edit (the
`git-identity` → `git` rename landing mid-session) transiently broke that
exact build via a project reference, at a moment chosen by another agent's
commit, not this one. Moved the build to the *host*, once, before `docker
build` even runs (`scripts/deploy-check.sh` now runs
`npx tsc -b examples/example-machine` first) and `COPY`s the resulting
`lib/` output into the image (`.dockerignore` no longer excludes `lib/`,
only `node_modules`, which is still installed fresh inside the container).
This fully decouples the image build from the timing of concurrent
`packages/*` edits landing.

### 6. The harness's own log-capturing was broken — `grep` on a transcript instead of a path

**Command:** `docker run --rm machine-run-deploy-check:latest` (same run as
finding #5 — this bug was masking what the *real* result would have looked
like once #5 was fixed).

**Observed:** every assertion after the first printed
`grep: [05:00:47.294] ERROR (...): <rest of the alchemy error transcript>: No
such file or directory` and then reported `[PASS]` regardless — because
`grep` failed to open a "file" that was actually the entire multi-line
alchemy transcript, and a `grep` that errors out finding nothing is
indistinguishable, to `grep -q`'s exit code, from a `grep` that ran cleanly
and found nothing — which `assert_not_contains` reads as a pass.

**Diagnosis: a bug in `scripts/container/entrypoint.sh`, not Alchemy or this
repo.** `run_plan`/`run_deploy` piped `alchemy`'s output through `tee
"$out"` and then did `echo "$out"` to hand the log path back to the caller
via command substitution — but `tee` also writes that same output to the
function's own stdout, so `plan1="$(run_plan initial)"` captured the *entire
alchemy transcript*, not the path, with the real path only as its last line.
Every subsequent `assert_contains "$plan1" ...` was therefore grepping a
giant blob of transcript text as if it were a filename. This would have
silently turned every later assertion in this script into a false pass.

**Fix applied:** split `run_plan`/`run_deploy` (which only stream + tee, no
return value) from `plan_log`/`deploy_log` (which compute the deterministic
log path from a label, with no command substitution involved in capturing
program output). See that script for the corrected version.

### 7. Hand-assembling providers to dodge instability was itself the trap

**Context:** to keep `alchemy.container.ts` decoupled from `@machine-run/machine`'s
aggregate `providers()` (which, at one point mid-session, briefly failed to
type-check because a new `packages/git` — the `git-identity` → `git` rename
in progress — added a `Git.Config` resource type to the aggregate), it was
rewritten to hand-assemble just `Dotfiles.providers()` / `Secrets.providers()`
/ `SystemPackages.providers()` directly, the way `alchemy.run.ts` used to.

**What that immediately broke:** `gitIdentity()` (used at the time) is a
*composition function* — its transitive provider requirement (`Git.Config`,
once `git-identity` became a thin re-export of `@machine-run/git`) is
invisible at the call site. Hand-assembling providers is only safe for a
recipe that calls resources directly; the moment it calls a composition
function from another package, the aggregate (`@machine-run/machine`) is the
only thing that can't have this gap by construction — which is the entire
reason that package exists (see its own doc comment). This recipe got bitten
by exactly the failure mode it was hand-assembling providers to avoid.

**Not a machine-run bug** so much as a real design tradeoff worth recording:
prefer `Machine.providers()` for any recipe that uses more than the bare
primitives directly, even at the cost of coupling to whatever's newest in
that aggregate.

### 8. `alchemy plan`/`deploy` never run: `Fiber.runLoop: Not a valid effect: undefined`

This is the actual result of this task. Nothing above blocked it — once
findings 1–7 were addressed, the container built cleanly, `examples/example-machine`
typechecked cleanly, and `lib/` resolved correctly at runtime (confirmed by
directly `import()`-ing `alchemy.container.ts` under plain `node`, which
succeeded). The engine itself has still never successfully run a plan.

**Command:** `node node_modules/alchemy/bin/alchemy.js plan alchemy.container.ts`
(equivalently, `node_modules/.bin/alchemy plan alchemy.container.ts` — the
real CLI entrypoint), from inside `examples/example-machine`, both inside the
container and directly on the host.

**Observed:** exit code `1`, with **zero output on stdout or stderr**. The
normal CLI path gives no error message at all — `alchemy`'s own error
reporting never surfaces anything.

**How the real cause was found:** the CLI's own error-reporting is silent, so
the failure had to be reproduced by bypassing `NodeRuntime.runMain` (which
`alchemy/Cli`'s `main` is normally piped through) and running the exact same
`main` Effect directly:

```js
process.argv = [process.argv[0], "alchemy", "plan", "alchemy.container.ts"];
const { main } = await import("alchemy/Cli");
const Effect = await import("effect/Effect");
const Cause = await import("effect/Cause");
const exit = await Effect.runPromiseExit(main);
console.error(exit._tag, exit._tag === "Failure" ? Cause.pretty(exit.cause) : exit.value);
```

which prints:

```
Failure
Error: Fiber.runLoop: Not a valid effect: undefined
    at causePrettyError (file:///.../node_modules/effect/dist/internal/effect.js:231:13)
```

— a `Die` defect (`{ _tag: "Die", defect: "Fiber.runLoop: Not a valid effect: undefined" }`),
not a typed failure. Something, somewhere in the CLI → `Plan.make` path,
yields `undefined` to Effect's fiber runtime where an `Effect` was expected.

**Bisection — this is not machine-run's bug:**

1. Reproduced with the real `alchemy.container.ts` (7 resources across 6
   packages).
2. Reproduced with a recipe containing a single `Dotfiles.File` resource and
   nothing else.
3. Reproduced with **zero resources** — `Effect.gen(function* () { yield*
   Effect.void; })` as the entire program, with real `Dotfiles.providers()` +
   `@machine-run/core` services still wired in.
4. Reproduced with **zero custom providers at all** — `providers: Layer.empty`,
   no `@machine-run/*` import whatsoever, just
   `Alchemy.Stack<{}>()("debug-bare", { providers: Layer.empty, state: Alchemy.localState() }, Effect.gen(function* () { yield* Effect.void; }))`.
5. Reproduced identically **on the host** (macOS, outside Docker entirely,
   with `HOME` overridden to a scratch directory) — ruling out anything
   Linux- or container-specific.

Step 4 is the load-bearing one: this is the smallest possible Alchemy stack —
no machine-run code, no custom resources, no custom providers — and it still
dies with the identical defect through the identical code path. Nothing in
`packages/*`, `docker/`, or `scripts/` is implicated by the time you reach
step 4.

**Diagnosis: a bug in the currently-pinned `alchemy@2.0.0-beta.72` /
`effect@4.0.0-rc.108` combination (or a genuine incompatibility between
them), not in this repo.** `alchemy`'s `package.json` declares
`"effect": ">=4.0.0-beta.105 || >=4.0.0"`, which `4.0.0-rc.108` satisfies by
semver range — but pre-1.0 beta/rc software satisfying a peer range is not
the same claim as "this exact combination was ever tested together," and
Effect's own internal `Fiber`/generator protocol is exactly the kind of thing
that changes shape between beta and rc without a version bump anyone would
notice from a `peerDependencies` range alone. This is squarely "Alchemy is a
dependency, not a fork" territory (`AGENTS.md` §1) — the fix belongs
upstream, not as a patch in this repo, and it was not investigated further
inside `alchemy`'s own (obfuscated/bundled) `lib/` output — that would mean
debugging a third party's bundle rather than reporting the reproduction.

**What this means for this task's actual goal:** every claim this repo makes
about `observe`/`diff`/idempotence/drift detection is still, as of this
writing, **unverified against a real `alchemy plan`** — not because those
reconcilers are wrong (nothing ever got far enough to ask), but because
Alchemy's own CLI cannot complete a plan for *any* stack, including an empty
one, against the versions this workspace currently has installed. Deploy,
drift-detection, and destroy (the rest of this task's checklist) are
unreachable until this is resolved — there is nothing further down the
pipeline to exercise.

**Suggested next steps, not taken here (out of this task's scope once the
blocker was this deep in a third-party dependency):**
- Try a different `effect` version pinned closer to what `alchemy@2.0.0-beta.72`
  was actually developed/tested against (check its own lockfile/CI pins in
  the published package, if any ship).
- Try a newer/older `alchemy` beta against the same `effect@4.0.0-rc.108`.
- Report the minimal step-4 repro upstream to Alchemy.

