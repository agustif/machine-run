# `@machine-run/state` — backlog

An `alchemy/State` `StateService` that wraps `LocalState`, encrypting each
row's value with a per-stack AES-256-GCM key on `set` and decrypting on `get`.
Full design in [docs/TASKS.md](../../docs/TASKS.md)'s "`Machine.EncryptedState`"
and [docs/CONCEPTS.md](../../docs/CONCEPTS.md)'s "`Redacted` does not protect
state at rest".

## Why this is its own package, not `core`

`core` has no internal dependencies — every other package depends on it, never
the reverse. The key for this store has to live somewhere reachable, and the
only home this repo already has for "where does a local secret live" is
`@machine-run/secrets`'s `keychain` backend, which itself depends on `core`
_and_ `engine`. Putting the state store in `core` would make `core` depend on
`secrets`, inverting the one dependency rule this repo enforces everywhere
else (AGENTS.md's layout section; verified by reading both packages'
`package.json`s before writing a line of this). A new package was the only
option that didn't invert something.

`engine` is deliberately **not** a dependency, even though `secrets`' own
`SecretBackend.read` signature references its `Exec` type. Nothing here needs
a `Reconciler`, and the one place an `Exec`-shaped function is needed
(`DataKey.ts`) declares its own structural type rather than importing one
package for a type alias — the same reason `packages/machine`'s `tsconfig.json`
doesn't list `engine` even though it depends on `secrets`, which does.

## Open items

- [ ] **`getOutput`/`setOutput` are not encrypted.** Passed straight through to
      the wrapped `LocalState` — see `EncryptedState.ts`'s doc comment. Nothing
      in this repo returns a stack output today (one stack manages one
      machine; see CONCEPTS.md's `Namespace` note), so this was deliberately
      cut from the five sub-tasks in docs/TASKS.md rather than left unnoticed.
      Extending `encrypt`/`decrypt` from `Envelope.ts` to these two methods is
      mechanical once something needs it.
- [ ] **The keychain write path (`DataKey.ts`'s `persistDataKey`) is
      macOS-only**, like every other consumer of `@machine-run/secrets`'s
      `keychain` backend. A Linux equivalent (`secret-tool`/libsecret) would
      need its own write primitive; nothing here abstracts over "a keychain",
      only over "the OS keychain via `security`".
- [ ] **No multi-process test.** The per-stack `Cache` in `EncryptedState.ts`
      only serialises key generation _within one process_. Two concurrent
      `alchemy deploy` invocations against a stack with no key yet could still
      race to write two different keys to the keychain — the last write wins,
      and whichever rows the losing process encrypted in that window become
      unreadable. This is a narrower version of a race `LocalState.ts` itself
      already has for state file writes generally, not something this store
      introduces.
- [ ] **Never run against a real `alchemy deploy`.** Like the rest of this
      repo (`docs/MAP.md`), this has only been exercised by calling
      `makeEncryptedState` directly in tests, not through `Alchemy.Stack`'s
      `state:` field in an actual CLI run.
