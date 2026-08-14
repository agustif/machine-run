# `@machine-run/secrets`

Materialises a secret from a vault onto disk as a file, over a pluggable
`SecretBackend` seam. Reconciles one thing: that a path holds the current
value from a named secret store, at the right permissions — never what that
value is, and never whether it has since rotated.

## What it exports

| Export                                                  | What it's for                                                                                                                                                                                         |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Machine.SecretFile` (`SecretFile.ts`)                  | One secret, materialised at a path with a given mode                                                                                                                                                  |
| `SecretSource` (`Backend.ts`)                           | A tagged union, one variant per store: `OnePassword { vault, item, field }`, `Doppler { project, config, name }`, `Keychain { service, account? }`, `Pass { path }`, `Env { variable }`               |
| `readSecret(source, exec)` (`Store.ts`)                 | Resolves any `SecretSource` to a `Redacted.Redacted<string>` by dispatching to the right backend — the same seam `@machine-run/ai` and `@machine-run/tailscale` use for their own secret-shaped props |
| `SecretBackend<S>` seam (`Backend.ts`, `backends/*.ts`) | One module per store: `OnePassword.ts`, `Doppler.ts`, `Keychain.ts`, `Pass.ts`, `Env.ts`                                                                                                              |

## The reference-not-value pattern

A recipe never writes a secret's value — only a typed reference to where it
lives, e.g. `{ _tag: "OnePassword", vault: "Personal", item: "GitHub SSH Key",
field: "private key" }`. `Machine.SecretFile`'s persisted state carries only
the path and the file's permissions — **never the secret's bytes, and never a
hash of them** (see `SecretFile.ts`'s own doc comment). The honest consequence
is that rotation behind an unchanged reference is undetectable: changing
_which_ secret a resource points at is caught as drift because the reference
is a prop, but a new value landing behind the same reference is not, short of
deleting the file to force a re-fetch. Recording a hash was considered and
rejected — see [TASKS.md](./TASKS.md)'s "Rotation detection" entry.

Every backend needs to be authenticated _before_ this runs — `op signin`,
`doppler login`, an unlocked keychain, an initialised `pass` store.
**machine-run never automates this.** A reconciler that can mint its own
credentials to a secret store could exfiltrate everything in it unattended;
`SecretAuthRequired`'s own message says to run the sign-in command yourself.

## Example

From `examples/complete-machine/recipes/secrets.ts`:

```ts
import * as Secrets from "@machine-run/secrets";

yield *
  Secrets.SecretFile("ssh-key", {
    path: "~/.ssh/id_ed25519_personal",
    source: {
      _tag: "OnePassword",
      vault: "Personal",
      item: "GitHub SSH Key",
      field: "private key",
    },
    mode: 0o600,
    directoryMode: 0o700,
    // OpenSSH rejects a private key with no trailing newline; explicit per
    // secret because getting it wrong fails silently in opposite directions.
    trailingNewline: "ensure",
  });

yield *
  Secrets.SecretFile("api-key-pass", {
    path: "~/.config/complete-machine/pass-token",
    source: { _tag: "Pass", path: "work/github/token" },
  });
```

## Verification status

**`pass` is the only backend of the five that has read a real secret** —
verified against `docker run --rm debian:stable`: a real `gpg --batch
--gen-key`, `pass init`, `pass insert -m` for both a single-line and a
multi-line secret, and `pass show` reading both back — confirming the
first-line-is-the-secret convention `Pass.ts` assumes, and that a missing
entry's real error text classifies as `SecretReadFailed`, not
`SecretCliMissing` (see
[../../docs/notes/secrets-pass-notes.md](../../docs/notes/secrets-pass-notes.md)).

**None of the other four — `1password`, `doppler`, `keychain`, `env` — has
ever read a real secret.** Doppler's flags were checked only against `doppler
secrets get --help`, which confirms the CLI's contract and nothing about its
actual output. `1password`/`keychain` need an authenticated vault or a real
macOS login keychain, neither of which this environment can supply without
automating authentication to a secret store — a rule this repo does not break
even to verify itself (see [../../AGENTS.md](../../AGENTS.md) §8, and rule 5's
container-first approach, which doesn't apply here since none of these can be
verified inside a disposable container). This remains **the least-verified
seam in the repo**, and it is the one writing files at `0o600` on the strength
of being right — see [../../docs/MAP.md](../../docs/MAP.md) §4.

## What it deliberately does not do

- **Never puts a secret value in Alchemy state.** Only the reference (a
  prop) and the file's path/mode (state) are persisted — see above.
- **Never automates authentication to a secret store.** See above.
- **No rotation detection.** A hash-based approach was considered and
  rejected precisely because it would mean deriving something from the secret
  and persisting it. See [TASKS.md](./TASKS.md).
- **No `bitwarden`, AWS Secrets Manager, or HashiCorp Vault backend.**
  Deliberately absent from `SecretSource` rather than a variant that could be
  named but not constructed.

See [TASKS.md](./TASKS.md) for the rest of the backlog.
