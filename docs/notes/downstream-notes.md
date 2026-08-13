# Downstream notes

Unverifiable claims, environment quirks, and lint findings from the pass that
touched `packages/tailscale`, `packages/ssh`, `packages/git-identity`,
`packages/ai-tools`, `examples/example-machine`, and root config. Anything
here is either "I could not check this against the real thing" or "this is a
real, observed problem outside the packages I'm scoped to."

## Unverifiable

- **`tailscale status --json`'s `BackendState` field.** `packages/tailscale/src/Connection.ts`
  decodes only `BackendState` via a `Schema.fromJsonString` and treats
  `"Running"` as "connected." The real Tailscale CLI is not installed in this
  environment, so the full JSON shape, and whether `BackendState` is really
  the most robust field to key off (vs. e.g. checking for a non-empty `Self`
  peer), is unverified against a real `tailscale status --json` — see the
  identical caveat already recorded in `docs/TASKS.md` for `op read`'s output
  shape.
- **`is command not found` substring classifier** (`isCommandNotFound` in
  `Connection.ts`) matches on `"command not found"` / `"enoent"` in a
  `CommandError`'s message. This mirrors the existing best-effort pattern in
  `@machine-run/secrets`'s backend classifiers (not my package, same
  limitation): wording is not a stable, localised API surface. Unverified
  against a real missing-binary `CommandError` on macOS/Linux/Windows.
- **fish's `function <name> --on-variable PWD ... end` and bash's
  `PROMPT_COMMAND` prepend** in `packages/git-identity/src/Identity.ts`
  (`renderGhAccountHook`) are written from documented fish/bash semantics, not
  exercised against a real fish or bash. Concretely: fish's `switch`/`case`
  glob matching and bash's `PROMPT_COMMAND` string-concatenation idiom for
  "run my hook, then whatever was already there" are standard, but neither
  was run interactively. The zsh branch (`chpwd_functions+=(...)`) is the one
  this repo already shipped and is unchanged in mechanism.

## Real problems found outside my scope (not fixed — forbidden/out of scope)

- **`packages/engine/src/toProvider.ts`'s `modes.live`/`modes.local` typing
  does not stay parameterized over `Res`.** As of this pass,
  `npx tsc -b` fails only on `examples/example-machine/alchemy.run.ts`'s
  final `Effect.gen` body, with `Provider<File>` (from
  `@machine-run/dotfiles`, built via `@machine-run/engine`'s new
  `toProvider`) not assignable to `ProviderServices`, because
  `modes.live`/`modes.local`'s `stables` field resolves to `string[]` instead
  of `(keyof FileState)[]`. `packages/engine` did not exist when this task
  was scoped and isn't in the editable list (`packages/dotfiles`, which
  consumes it, explicitly is not editable either) — it appears to be a
  same-session, in-flight refactor (dotfiles' `File`/`ManagedBlock`/`Symlink`
  were rewritten from the old `read`/`diff`/`reconcile`/`delete`
  `Provider.effect` shape to a `Reconciler`/`toProvider` abstraction partway
  through this pass). Flagging rather than fixing, since editing
  `packages/engine` or `packages/dotfiles` is outside this task's remit.
- **`@machine-run/engine`'s `toProvider` requires a live `CommandExecutor`
  for every resource kind**, including ones (`Machine.File`,
  `Machine.ManagedBlock`, `Machine.Symlink`) whose own reconcile logic never
  shells out. `examples/example-machine/alchemy.run.ts`'s top-level
  `providers` layer now pipes in `Layer.provide(CommandExecutorLive())`
  after `Core.services()` specifically to close this — see the comment
  above that line. Without it, `Dotfiles.providers()` alone leaks a bare
  `CommandExecutor` requirement that nothing in a typical recipe would
  otherwise supply (`Command.providers()`, `Secrets.providers()`, etc. each
  build and privately discard their own `CommandExecutorLive()` via
  `Layer.provide`, so none of them expose it for a sibling to reuse).
- **Root `alchemy`/`effect` devDependencies were briefly behind what
  packages' `peerDependencies` declared** during this pass (root read
  `alchemy@2.0.0-beta.67` / `effect@4.0.0-beta.102` while packages had
  already moved their peer ranges to `2.0.0-beta.72` / `4.0.0-rc.108`, via a
  concurrent process editing root config at the same time as this task). That
  mismatch, plus a **stale `packages/ai-tools/node_modules/alchemy` symlink
  pointing into a `node_modules/.bun/alchemy@2.0.0-beta.67+<hash>/...` cache
  path** (a leftover from a `bun install` that predates this pass's `npm
  install`s — npm cannot resolve a version from that path, hence
  `alchemy@undefined` in npm's own `ERESOLVE` warnings), is almost certainly
  the real mechanism behind the `TypeError: Invalid Version:` failure
  `docs/TASKS.md` already flagged. Deleting `package-lock.json` and
  reinstalling (see below) worked around it well enough to install `oxlint`
  even before the root/peer split closed; root's `alchemy` has since been
  bumped to `2.0.0-beta.72` too (by the same concurrent process), so at the
  time of writing root and every package peer range agree.

## `npm install -D oxlint@latest oxlint-plugin-effect@latest`

Diagnosed in the prescribed order:

1. **Pin `@types/node`.** Already `^24.0.0` by the time I checked (a
   concurrent process had made this exact change mid-session) — did not
   need to redo it.
2. **Remove `package-lock.json`.** This is what actually fixed the
   `TypeError: Invalid Version:` failure. With a fresh lockfile, npm still
   printed `ERESOLVE overriding peer dependency` / `Found: alchemy@undefined`
   warnings (see above) for `system-packages` and `tailscale`, but they were
   warnings, not failures, and the install completed:
   `added 4 packages, removed 1 package`. `oxlint@1.78.0` and
   `oxlint-plugin-effect@0.8.2` are now in root `devDependencies` and
   `node_modules/.bin/oxlint` works.
3. **`--legacy-peer-deps`** was not needed once the lockfile was
   regenerated.

## `.oxlintrc.json`

Created at repo root with `jsPlugins: ["oxlint-plugin-effect/plugin"]` and
every rule from `oxlint-plugin-effect`'s `recommended` preset set to
`"error"` — nothing mass-disabled. Ran:

```
node_modules/.bin/oxlint --config .oxlintrc.json packages examples
```

**157 `effect/*` errors repo-wide** (plus 2 unrelated built-in `eslint`
warnings: one `require-yield` in `system-packages/src/Repo.ts`, one
`no-useless-escape` in `git-identity/src/Identity.ts`, both pre-existing and
outside this rule set). Per-rule counts, repo-wide:

| Rule | Count |
| --- | --- |
| `effect/noNullish` | 65 |
| `effect/noAs` | 30 |
| `effect/noTernary` | 22 |
| `effect/noRuntimeTypeof` | 7 |
| `effect/noConditionalEmptyObjectSpread` | 6 |
| `effect/noGlobals` | 5 |
| `effect/noUnknownParameters` | 4 |
| `effect/noThrowStatement` | 4 |
| `effect/noKnownValueWidening` | 4 |
| `effect/noChainedTypeAssertions` | 4 |
| `effect/noUnsafeDictionaryType` | 2 |
| `effect/noAsyncFunction` | 2 |
| `effect/noNewError` | 1 |
| `effect/noObjectParameters` | **0** |

Within just the packages this task touched:

| Package | Violations |
| --- | --- |
| `packages/tailscale` | 5 `noTernary`, 3 `noNullish`, 2 `noAs`, 1 `noConditionalEmptyObjectSpread` (11 total) |
| `packages/ssh` | 1 `noTernary`, 1 `noNullish`, 1 `noConditionalEmptyObjectSpread` (3 total) |
| `packages/git-identity` | 2 `noTernary`, 2 `noNullish`, 1 `noConditionalEmptyObjectSpread` (5 total) |
| `packages/ai-tools` | 2 `noAs` |
| `examples/example-machine` | 0 |

### On the two rules the task called out as likely conflicting

- **`effect/noObjectParameters`** ("Bans the broad `object` type on function
  inputs") has **zero hits anywhere in this repo right now**. It targets a
  bare, untyped `object` annotation specifically — not an object-destructured
  parameter with a concrete interface, which is what every Alchemy provider
  hook (`diff: Effect.fn(function* ({ news, output }) {...})`,
  `reconcile: Effect.fn(function* ({ news, session }) {...})`) and every
  composition function in this task's scope (`sshHost(props: SshHostProps)`,
  `gitIdentity(props: GitPersonaProps)`) actually uses. So there is no live
  conflict to work around today — the risk is prospective: if anyone ever
  types a provider hook's parameter as literal `object` (rather than a named
  props/args interface), this rule would correctly flag it, and the fix
  there is to name the type, not disable the rule.
- **`effect/noNullish`** is the real, structural conflict, and it's the
  single largest category by a wide margin (65 of 157). Alchemy's `diff`
  contract *is* "return `undefined` for no-op, `{ action: ... }` otherwise" —
  every resource's `diff` in this codebase (`Connection.ts`,
  `File.ts`/`ManagedBlock.ts`/`Symlink.ts`/`SecretFile.ts` before their
  `engine` rewrite, `Default.ts`) returns `undefined` for that reason, and
  every optional prop (`hostname?`, `authKeySource?`, `after?`, `mode?`,
  `directoryMode?`, `shell?`, `shellRcPath?`) is `T | undefined` by
  TypeScript's own `?` semantics, not a choice this codebase made. Rewriting
  every optional prop and every `diff`/`read` return type to `Option<T>`
  would mean fighting both TypeScript's own optional-property sugar and
  Alchemy's `ResourceLike`/`Provider` types (which are defined in
  `node_modules/alchemy`, not editable), not a local style fix. Per the
  task's instruction, this rule is left enabled (not disabled) and its
  violations are reported here rather than suppressed.

None of the 157 violations were fixed as part of this pass — the task asked
for the real counts, not a clean run, and said explicitly not to mass-disable
rules to force one.
