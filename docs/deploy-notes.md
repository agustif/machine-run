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

**Fix applied:** added `RUN npx tsc -b examples/example-machine` to the
Dockerfile, after `npm install`. Deliberately scoped to that one project
(and its project-referenced dependencies) rather than the whole workspace's
`tsc -b` — see finding #2 for why the whole-workspace build was, at various
points during this session, not green for reasons unrelated to this task.

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

