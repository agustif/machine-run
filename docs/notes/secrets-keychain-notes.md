# secrets: `keychain` verification (successful-read shape)

`keychain` (`packages/secrets/src/backends/Keychain.ts`) already had its
missing-entry signal verified earlier this session (real macOS, real `security
find-generic-password -s <nonexistent> -w`: exit `44`, stderr `security:
SecKeychainSearchCopyNext: The specified item could not be found in the
keychain.` — see `isNoSuchKeychainItem`'s doc comment in `Keychain.ts` and
`SecretNotFound`'s in `Backend.ts`). This note covers what was still assumed:
the shape of a *successful* `-w` read, specifically for values that are not a
single line of plain ASCII — the case `KeychainBackend.read`'s comment calls
out (`-w` prints only the password to stdout) without ever having been
checked against a value more complex than that.

## What was run

On this machine's real macOS login session (Darwin, 2026-08-14) — no docker,
since `security` is macOS-only. A disposable keychain was created, added to
the *user* search list only for the duration of this session, queried, then
the search list was restored to its original two entries
(`login.keychain-db`, `System.keychain`) and the disposable keychain file was
deleted. The real login keychain was never touched or unlocked.

```sh
security create-keychain -p <throwaway-pw> mr-secrets-test.keychain-db
security unlock-keychain -p <throwaway-pw> mr-secrets-test.keychain-db
security list-keychains -d user -s login.keychain-db System.keychain mr-secrets-test.keychain-db

security add-generic-password -a "" -s mr-secrets-test-simple    -w "sup3rKeychainSecret"     -A mr-secrets-test.keychain-db
security add-generic-password -a agustif-test -s mr-secrets-test-account -w "withAccountSecret" -A mr-secrets-test.keychain-db
security add-generic-password -a "" -s mr-secrets-test-space     -w "hello world with spaces" -A mr-secrets-test.keychain-db
security add-generic-password -a "" -s mr-secrets-test-multiline -w "line1
line2
line3" -A mr-secrets-test.keychain-db   # embedded newlines, no trailing one
security add-generic-password -a "" -s mr-secrets-test-tab       -w "tab	separated" -A mr-secrets-test.keychain-db

security find-generic-password -s mr-secrets-test-simple    -w mr-secrets-test.keychain-db
security find-generic-password -s mr-secrets-test-account -a agustif-test -w mr-secrets-test.keychain-db
security find-generic-password -s mr-secrets-test-space     -w mr-secrets-test.keychain-db
security find-generic-password -s mr-secrets-test-multiline -w mr-secrets-test.keychain-db
security find-generic-password -s mr-secrets-test-tab       -w mr-secrets-test.keychain-db

# for comparison, the same multi-line entry via `-g` instead of `-w`:
security find-generic-password -s mr-secrets-test-multiline -g mr-secrets-test.keychain-db
```

(`-A` — "allow any application" — was used for `add-generic-password` rather
than `-T ""`. An earlier attempt in this session used `-T ""`, which correctly
denies default app trust but then made the read-back require an interactive
Keychain Access-control prompt; the `security find-generic-password` process
hung against that real GUI prompt until this session killed it at the 120s
mark. That is itself consistent with — not a contradiction of — the already
documented "a locked keychain blocks on an interactive Security Agent prompt"
finding: an ACL-denied item produces the same kind of blocking prompt as a
locked keychain, for the same underlying reason (the OS needs a human at the
keyboard). `-A` was used for the rest of this session's entries specifically
to avoid that, since only the read-back format was in question here, not
the access-control path.)

## What was observed

- `mr-secrets-test-simple` (`sup3rKeychainSecret`, plain ASCII, no
  whitespace): `-w` printed `sup3rKeychainSecret\n` — the exact value plus
  one trailing newline, confirmed byte-for-byte with `od -c`.
- `mr-secrets-test-account` (with `-a agustif-test`, `withAccountSecret`):
  same shape, `withAccountSecret\n` — confirms the `-a` flag round-trips
  correctly alongside `-s` the way `KeychainBackend.read` assembles them.
- `mr-secrets-test-space` (`hello world with spaces`, printable ASCII with
  embedded spaces): `-w` printed the literal string plus one trailing
  newline. Embedded spaces are not a problem.
- `mr-secrets-test-multiline` (`line1\nline2\nline3`, embedded newlines):
  `-w` printed **`6c696e65310a6c696e65320a6c696e6533` — the ASCII-hex
  encoding of the stored bytes, not the bytes themselves** — plus one
  trailing `\n` from `security` itself. Decoded, that hex is exactly
  `line1\nline2\nline3`, so the value is not corrupted at rest — but the
  bytes `KeychainBackend.read` receives on `stdout` are the hex text, and
  `.replace(/\n$/, "")` on that text produces the literal string
  `"6c696e6531...` (the hex digits, verbatim), not the real secret.
- `mr-secrets-test-tab` (`tab<TAB>separated`, one embedded tab, no
  newlines): same hex-encoding behaviour — confirms this is not specific to
  `\n`, but to non-printable bytes generally (`\t` is `0x09`, also outside
  `isprint()`'s printable range).
- For comparison, `security find-generic-password -s mr-secrets-test-multiline
  -g` (the `-g` flag, not `-w`) printed:
  `password: 0x6C696E65310A6C696E65320A6C696E6533  "line1\012line2\012line3"`
  — an unambiguous, self-describing form (`0x<hex>` for the raw-byte case,
  versus a bare `password: "quoted string"` line for the printable case,
  confirmed separately against the plain-ASCII entry). `-w` has no equivalent
  marker: its output for a hex-encoded value is byte-for-byte indistinguishable
  from `-w`'s output for a real secret that merely happens to look like a
  hex-digit string.

Full raw bytes are saved as
`packages/secrets/test/fixtures/keychain-multiline-hex-stdout.txt`.

## Resolution

The `-w` result above was a real corruption finding. It is now fixed in
`KeychainBackend.read`: the command uses `-g`, and the parser distinguishes the
explicit `password: 0x<hex>` raw-byte form from the printable quoted form.
The hex form is decoded byte-for-byte before being wrapped in `Redacted`, so a
multi-line secret cannot silently become its ASCII representation.

The regression cases are in `packages/secrets/test/Keychain.test.ts`, with the
captured transcripts in `packages/secrets/test/fixtures/`. The current
inventory is therefore `✓ keychain` in [MAP.md](../MAP.md); the remaining
limitation is the already documented possibility of an interactive macOS
Keychain access-control prompt, not a silent successful-read corruption.
