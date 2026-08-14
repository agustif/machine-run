# secrets: `pass` verification

`pass` (`packages/secrets/src/backends/Pass.ts`) is the first backend in the
`secrets` seam to read a real secret out of a real (if disposable) vault. At
the time of this capture, `keychain` was still awaiting its real macOS check;
that check and its successful-read fix are now recorded in
`docs/notes/secrets-keychain-notes.md`. `1password`/`doppler` still need an
authenticated account this session has neither the credentials nor the
authority to create (see `AGENTS.md` rule 8 — never automate authentication to
a secret store), and `env` reads `process.env` directly and has no CLI to
verify.

## What was run

`docker run --rm debian:stable bash`, then:

```sh
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq pass gnupg pinentry-curses

export GNUPGHOME=/root/.gnupg
mkdir -p "$GNUPGHOME" && chmod 700 "$GNUPGHOME"
gpg --batch --gen-key <<'EOF'
%no-protection
Key-Type: RSA
Key-Length: 2048
Subkey-Type: RSA
Subkey-Length: 2048
Name-Real: Test User
Name-Email: test@example.com
Expire-Date: 0
%commit
EOF

pass init test@example.com

printf 'sup3rsecret\n' | pass insert -m work/github/token
printf 'ghp_abc123XYZ\nusername: agustif\nurl: https://github.com\n' | pass insert -m work/github/pat

pass show work/github/token
pass show work/github/pat
pass show nope/does/not/exist   # never inserted
pass ls
```

`%no-protection` in the GPG batch key-gen means the key has no passphrase —
deliberate, so nothing here needed to script an interactive pinentry prompt.
This does not touch `AGENTS.md` rule 8 ("never automate authentication to a
secret store"): the key is a disposable one this session generated for its own
disposable container, not a login to any real, pre-existing vault.

## What was observed

- `pass show work/github/token` printed exactly `sup3rsecret`.
- `pass show work/github/pat` printed all three lines back verbatim:
  ```
  ghp_abc123XYZ
  username: agustif
  url: https://github.com
  ```
- `pass show nope/does/not/exist` (a path never inserted) failed on stderr with
  `Error: nope/does/not/exist is not in the password store.`, exit 1.
- `pass ls` printed the expected tree (`Password Store` → `work` →
  `github` → `pat`, `token`).

## What this confirms about `Pass.ts`

`PassBackend.read` does `result.stdout.split("\n")[0]` — only the first line.
Real `pass show` output for the multi-line entry above confirms this is
correct, not just documented: the secret genuinely is line 1, and `pass
insert -m`'s own multi-line convention genuinely does put metadata below it.
Before this session that was an assumption from `pass`'s man page; now it's
observed.

`classify`'s fallback path is also confirmed correct rather than merely
plausible: the real "not in the password store" error contains neither
"command not found" nor "enoent", so it correctly falls through to
`SecretReadFailed` (a resolvable-store, bad-reference error) instead of being
misread as `SecretCliMissing` (the CLI itself absent) — two very different
user-facing messages that a wrong classification would have swapped.

No parser or classifier change was needed. `test/Pass.test.ts` pins both
findings — the first-line extraction (with real captured multi-line stdout,
not an invented fixture) and the missing-entry classification (with the real
captured stderr text as `UnexpectedExit.stderr`).

`pass` is `✓` in [MAP.md](../MAP.md) as of this session. The current seam
status is `✓ env`, `✓ pass`, `✓ keychain`, and `~ 1password`/`~ doppler`; the
latter two still need authenticated accounts, which this environment cannot
supply without violating rule 8.
