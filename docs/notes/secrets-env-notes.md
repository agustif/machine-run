# secrets: `env` verification

`env` (`packages/secrets/src/backends/Env.ts`) has no CLI to shell out to — it
reads `Config.redacted(variable)` from `effect/Config`, which resolves through
whatever `ConfigProvider` is in scope, defaulting to `ConfigProvider.fromEnv()`
when nothing overrides it. That default is exactly `process.env`. Every
existing test in this package (`SecretFile.test.ts`, `Store.test.ts`) already
exercises `Config.redacted` for real, but always with an explicit
`ConfigProvider.fromEnvRecord({...})` override supplying a synthetic record —
never the actual default provider reading the actual OS process environment.
That gap is what this session closes.

## What was run

`docker run --rm --name mr-secrets-env-verify4 -e MACHINE_RUN_TEST_SECRET=sup3rEnvSecret -v <scratch>:/work -w /work node:22-slim node check.mjs`,
where `check.mjs` (kept alongside this note in
`packages/secrets/test/fixtures/env-real-container-run.txt`'s header) is:

```js
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";

const run = async (label, name) => {
  const exit = await Effect.runPromiseExit(Config.redacted(name));
  console.log(label, JSON.stringify(exit));
};

await run("SET_VAR:", "MACHINE_RUN_TEST_SECRET");
await run("UNSET_VAR:", "MACHINE_RUN_TEST_SECRET_DOES_NOT_EXIST");
```

`effect@4.0.0-rc.108` (matching this repo's pinned version) was `npm install`'d
into the container first. No `ConfigProvider` override is provided anywhere in
this script — `Config.redacted` runs against whatever `effect`'s own
`Context.Reference` default supplies, which is `fromEnv()`, i.e. genuinely
`process.env` of the container's `node` process, set by `docker run -e` before
`node` ever started.

A second run, `check2.mjs`, unwraps the `Redacted` value with `Redacted.value`
to confirm the successful read isn't just `Exit._tag: "Success"` but the real
literal string:

```js
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as Redacted from "effect/Redacted";

const value = await Effect.runPromise(Config.redacted("MACHINE_RUN_TEST_SECRET"));
console.log("UNWRAPPED:", Redacted.value(value));
```

## What was observed

- `check.mjs`'s `SET_VAR:` line: `{"_id":"Exit","_tag":"Success","value":"<redacted>"}` —
  a real success, `Redacted`'s own `toJSON` correctly refusing to print the
  wrapped value even in a raw `Exit` dump.
- `check.mjs`'s `UNSET_VAR:` line: `{"_id":"Exit","_tag":"Failure", ...}` whose
  failure is tagged `"ConfigError"` (further wrapped in a `SchemaError` /
  `InvalidType` issue) — a real, structured `ConfigError`, not a string message.
- `check2.mjs`: `UNWRAPPED: sup3rEnvSecret` — the exact literal value set via
  `docker run -e`, round-tripped through `Config.redacted` and `Redacted.value`
  with no corruption or truncation.

Full raw output is captured in
`packages/secrets/test/fixtures/env-real-container-run.txt`.

## What this confirms about `Env.ts`

`EnvBackend.read`'s assumption — that `Config.redacted(source.variable)` with
no `ConfigProvider` override reads the real OS environment — is now observed,
not merely read off `effect`'s own doc comments. The successful path returns
the real value verbatim (confirmed by `check2.mjs`), and the missing-variable
path fails with a `ConfigError`, not a `CommandError` — irrelevant to
`EnvBackend.read`'s classification, since its `Effect.catch(() => new
SecretReadFailed({ source, cause: undefined }))` catches *any* failure in the
error channel unconditionally, regardless of the failure's tag or shape. There
is no substring-matching classifier to get wrong here, unlike the CLI-backed
backends — the one thing to verify was that the default provider really is
`process.env`, and it is.

## A real caveat this surfaced (already known elsewhere in this repo)

`effect`'s `ConfigProvider.ConfigProvider` is a `Context.Reference` whose
default value (`fromEnv()`) is constructed lazily on first access and then
held for the process's lifetime — it snapshots `process.env` once, and does
not re-read it. `packages/git/test/Config.test.ts` and
`packages/ai/test/McpServer.test.ts` already document this independently
(verified there by reading `effect`'s own `ConfigProvider.fromEnv` source).
It applies identically here: this is why the container run above sets
`MACHINE_RUN_TEST_SECRET` via `docker run -e` *before* `node` starts, rather
than mutating `process.env` mid-script — and why this package's own tests
correctly use an explicit `ConfigProvider.fromEnvRecord`/`fromEnv({ env })`
override rather than relying on later `process.env` mutation to simulate a
changed secret. For `Machine.SecretFile`'s own usage this is not a live
concern: a reconciler `apply` reads its recipe's referenced env vars once, at
the point it resolves the secret, consistent with a one-shot run rather than
a long-lived process watching for changes.

## Backend list

`env` is `✓` in [MAP.md](../MAP.md) as of this session — the first backend
verified with no account and no dependency on any CLI at all, using nothing
but a disposable container and the same `effect` package version this repo
pins.
