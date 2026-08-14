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

Two of five backends have read a real secret: **`pass`**, verified against
`docker run --rm debian:stable` — a real `gpg --batch --gen-key`, `pass init`,
`pass insert -m` for both a single-line and a multi-line secret, and `pass
show` reading both back, confirming the first-line-is-the-secret convention
`Pass.ts` assumes (see
[../../docs/notes/secrets-pass-notes.md](../../docs/notes/secrets-pass-notes.md)) —
and **`env`**, verified with no CLI at all: a set variable round-tripped its
exact value and an unset one raised a real `ConfigError` (see
[../../docs/notes/secrets-env-notes.md](../../docs/notes/secrets-env-notes.md)).

`1password` and `doppler` have not read a real secret — both need an
authenticated account this repo deliberately never creates (see
[../../AGENTS.md](../../AGENTS.md) §8) — but each backend's
`SecretAuthRequired` classification was checked against its CLI's real
unauthenticated error text, which turned up a genuine gap in both (now fixed
and pinned in `test/OnePassword.test.ts`/`test/Doppler.test.ts`; see
[../../docs/notes/secrets-op-notes.md](../../docs/notes/secrets-op-notes.md)
and
[../../docs/notes/secrets-doppler-notes.md](../../docs/notes/secrets-doppler-notes.md)).

`keychain` reads with `security find-generic-password -g`, not `-w`. `-w` prints
the ASCII-hex encoding of the stored bytes rather than the bytes whenever a
secret contains a byte outside `isprint()` — the shape of every SSH key and PEM
certificate — and exits `0` with no signal. `-g` distinguishes the two forms
(`password: 0x<hex>` versus `password: "quoted"`), which is why it is used here.
See [../../docs/notes/secrets-keychain-notes.md](../../docs/notes/secrets-keychain-notes.md).

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
