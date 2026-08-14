# secrets: `1password` (`op`) verification

`1password` (`packages/secrets/src/backends/OnePassword.ts`) needs a real
vault to prove a successful read — out of scope here (`AGENTS.md` rule 8: never
automate authentication to a secret store, and no account exists to sign into
even if that rule didn't apply). What a container *can* verify without any
account at all is `op`'s own unauthenticated error text, and whether
`classify` really buckets it as `SecretAuthRequired` the way its comment
claims.

## What was run

`docker run --rm --name mr-secrets-op-verify3 debian:stable`, installing the
real 1Password CLI from its official apt repo (arm64, matching this host):

```sh
curl -sS https://downloads.1password.com/linux/keys/1password.asc | gpg --dearmor --output /usr/share/keyrings/1password-archive-keyring.gpg
echo "deb [arch=arm64 signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/arm64 stable main" > /etc/apt/sources.list.d/1password.list
apt-get update -qq
apt-get install -y -qq 1password-cli   # installed 2.38.1
op read "op://Personal/does-not-exist/field"
```

No account was ever added (`op account add` was never run), and no
`OP_SERVICE_ACCOUNT_TOKEN`/`OP_CONNECT_*` env vars were set — this is `op` in
its genuinely out-of-the-box, zero-configuration state.

## What was observed

Exit code `1`. Full stderr (also saved verbatim as
`packages/secrets/test/fixtures/op-unauthenticated-stderr.txt`):

```
No accounts configured for use with 1Password CLI.

 - Turn on the 1Password desktop app integration to sign in with the accounts you've added to the app: https://www.1password.dev/cli/app-integration/ for details.
 - Add an account manually with 'op account add' and sign in by entering your password on the command line. See 'op account add --help' for details.
 - Authenticate using a 1Password service account by setting the 'OP_SERVICE_ACCOUNT_TOKEN' environment variable to your service account token. Learn more: https://www.1password.dev/service-accounts/
 - Use 1Password CLI with a Connect server by setting the 'OP_CONNECT_HOST' and 'OP_CONNECT_TOKEN' environment variables to your Connect host and token, respectively. Learn more: https://www.1password.dev/connect/
[ERROR] 2026/08/14 04:07:09 could not read secret 'op://Personal/does-not-exist/field': error initializing client:
```

(That trailing `error initializing client:` really does end with a bare
colon and nothing after it — confirmed byte-for-byte with `od -c`, not a
copy-paste truncation.)

## What this confirms — and what it caught

Before this session, `OnePasswordBackend`'s `classify` bucketed
`SecretAuthRequired` on `message.includes("not signed in") ||
message.includes("no valid session") || message.includes("authentication")`.
None of those three substrings appear in the real text above — the closest is
`Authenticate using a 1Password service account`, which is "Authenticate", not
"authentication", so `.includes("authentication")` does not match it either.
**The real, most basic unauthenticated state — `op` with zero accounts
configured at all — fell through to the generic `SecretReadFailed` bucket
instead of `SecretAuthRequired`,** the opposite of what the doc comment
claimed and exactly the kind of gap this task exists to catch. `classify` now
also checks `message.includes("no accounts configured")`, matched against this
real captured text, so this specific and very-likely-to-be-hit case now
routes to `SecretAuthRequired` as intended.

The three original substrings are left in place rather than removed: they may
still be correct for other real `op` states this environment cannot produce
without an account (an expired session after a prior sign-in, for instance,
which — going by 1Password's own docs — is understood to read along the
lines of "not currently signed in") but that specific text was not, and could
not be, captured here. Those three remain unverified assumptions; only
`no accounts configured` is now a verified one.

`op`'s `read` happy path (a successful vault read) and its output-shaping
(trailing newline behaviour, `op read --no-newline`, etc. — see
`packages/secrets/TASKS.md`) remain completely unverified; this session only
closes the `SecretAuthRequired` classification gap. `1password` stays `~` in
[MAP.md](../MAP.md) — a corrected classifier is not a successful read of a
real secret, and claiming otherwise would be exactly the dishonesty this task
warns against.
