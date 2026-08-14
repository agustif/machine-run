# `@machine-run/state`

An optional Alchemy `StateService` that wraps `LocalState`, encrypting each
row's value with a per-stack AES-256-GCM key on `set` and decrypting it on
`get`. Not a resource package, and not required — a recipe can use Alchemy's
plain `localState()` instead, the way every example in this repo does today.
It sits sideways from the rest of the stack rather than below it: the data key
comes from `@machine-run/secrets`'s `keychain` backend, so putting this in
`core` would make `core` depend on `secrets`, inverting the one dependency rule
the rest of the repo follows (see [TASKS.md](./TASKS.md)).

## Threat model

This protects **disk-at-rest reads only** — a stolen laptop, a synced backup,
a `.alchemy/` directory accidentally committed or uploaded. It does **not**
protect against anything already running as the user on this machine: that
process can ask the keychain for the same key this store does, exactly as it
could read `~/.ssh/id_ed25519` directly. See
[../../docs/CONCEPTS.md](../../docs/CONCEPTS.md)'s "`Redacted` does not protect
state at rest" for the finding that motivated building this at all.

## What it exports

| Export                                                                          | What it's for                                                                                                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `makeEncryptedState(...)` (`EncryptedState.ts`)                                 | Builds a `StateService` that wraps `alchemy/State`'s `makeLocalState`, encrypting/decrypting each row's `set`/`get`                  |
| `ensureDataKey` / `readDataKey` (`DataKey.ts`)                                  | Generates (or reads back) this stack's AES-256-GCM key, stored in the macOS keychain via `@machine-run/secrets`'s `Keychain` backend |
| `Envelope.ts` (`encrypt`, `decrypt`, `Envelope`, `additionalData`, `KEY_BYTES`) | The actual AES-256-GCM envelope format — ciphertext, nonce, and AAD binding the value to its row                                     |

## Example

There is no recipe in `examples/` using this — every example uses Alchemy's
own `Alchemy.localState()` instead. Derived from `test/EncryptedState.test.ts`,
the shape of using it directly:

```ts
import { makeEncryptedState } from "@machine-run/state";
import * as Alchemy from "alchemy";

export default Alchemy.Stack(
  "my-machine",
  {
    providers: Machine.providers(),
    state: makeEncryptedState(), // in place of Alchemy.localState()
  },
  Effect.gen(function* () {
    /* ... */
  }),
);
```

## Verification status

Exercised only by calling `makeEncryptedState` and the `Envelope`
encrypt/decrypt functions directly in tests
(`test/EncryptedState.test.ts`, `test/Envelope.test.ts`). Never run against a
real `alchemy deploy`'s `state:` field — like everything else in this repo, it
has not been run by the Alchemy engine (see
[../../docs/MAP.md](../../docs/MAP.md)).

## What it deliberately does not do

- **Does not encrypt `getOutput`/`setOutput`.** Those two `StateService`
  methods pass straight through to the wrapped `LocalState` unencrypted —
  nothing in this repo returns a stack output today (one stack manages one
  machine), so this was deliberately scoped out rather than left unnoticed.
  See [TASKS.md](./TASKS.md).
- **Keychain write path is macOS-only.** `DataKey.ts`'s `persistDataKey` goes
  through `security`, like every other consumer of `@machine-run/secrets`'s
  `keychain` backend. There is no Linux (`secret-tool`/libsecret) equivalent.
- **Does not unblock `Ssh.Key`.** Building this store was a prerequisite for
  eventually materialising `Ssh.Key`'s private half from a vault, but whether
  that's still the wrong primitive at all is a separate, undecided question —
  see [../../docs/CONCEPTS.md](../../docs/CONCEPTS.md) and
  [TASKS.md](./TASKS.md).
- **No cross-process protection for key generation.** Two concurrent `alchemy
deploy` runs against a stack with no key yet could race to write two
  different keys to the keychain; the per-process `Cache` in
  `EncryptedState.ts` only serialises within one process.

See [TASKS.md](./TASKS.md) for the rest.
