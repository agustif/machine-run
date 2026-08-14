# secrets: `doppler` verification

`doppler` (`packages/secrets/src/backends/Doppler.ts`) needs a real Doppler
project/config to prove a successful read — out of scope here for the same
reason as `1password` (`AGENTS.md` rule 8, and no account exists to create
one with anyway). Before this session, `Doppler.ts`'s doc comment only
claimed the CLI's flags were checked against `doppler secrets get --help` —
its own contract, not its output. This session runs the CLI for real, twice,
against two different unauthenticated states.

## What was run

`docker run --rm --name mr-secrets-doppler-verify3 debian:stable` (no token
anywhere in the environment), installing the real Doppler CLI from its
official apt repo (arm64) — note the apt package is named `doppler`, not
`doppler-cli` (the latter 404s with "Unable to fetch secrets" a very
different, misleading error from apt itself, not Doppler — a naming trap this
session hit and is worth recording so a future session doesn't repeat it):

```sh
curl -sLf --retry 3 --tlsv1.2 --proto "=https" "https://packages.doppler.com/public/cli/gpg.DE2A7741A397C129.key" | gpg --dearmor -o /usr/share/keyrings/doppler-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/doppler-archive-keyring.gpg] https://packages.doppler.com/public/cli/deb/debian any-version main" > /etc/apt/sources.list.d/doppler-cli.list
apt-get update -qq
apt-get install -y -qq doppler   # installed v3.76.4
doppler secrets get SOME_SECRET --plain --project someproj --config someconfig
```

A second container, `mr-secrets-doppler-verify4`, ran the identical command
with `DOPPLER_TOKEN=dp.st.dev.thisisnotarealtoken1234567890` set — a
syntactically plausible but entirely fabricated service-account token, never
issued by any real Doppler account, to observe the CLI's *invalid*-credential
error text as distinct from its *no*-credential text.

## What was observed

Both exited `1`. Real stderr, also saved as
`packages/secrets/test/fixtures/doppler-no-token-stderr.txt` and
`packages/secrets/test/fixtures/doppler-invalid-token-stderr.txt`:

- No token at all: `Doppler Error: you must provide a token`
- Fake/invalid token: `Unable to fetch secrets` then `Doppler Error: Invalid Auth token`

## What this confirms — and what it caught

`DopplerBackend`'s `classify` bucketed `SecretAuthRequired` on
`message.includes("unauthorized") || message.includes("invalid auth
token")`. The *invalid token* case matches — `"invalid auth token"` (matched
case-insensitively) appears verbatim in the real captured text, so that half
of the classifier was already correct, not merely plausible.

**The *no token* case did not match either substring** and fell through to
the generic `SecretReadFailed` bucket — the same shape of gap found in
`OnePassword.ts`, and arguably a more likely one to hit in practice: an
operator who has simply never configured Doppler at all (no
`DOPPLER_TOKEN`, never ran `doppler login`) is a more common first
experience than one holding a token that turns out to be invalid.
`classify` now also checks `message.includes("you must provide a token")`,
matched against this real captured text, so both real "not authenticated"
states this session could produce now route to `SecretAuthRequired`.

`doppler`'s `read` happy path (a real project/config/secret lookup) remains
completely unverified — this session only closes two classification gaps
using the CLI's own real, unauthenticated error text. `doppler` stays `~` in
[MAP.md](../MAP.md).
