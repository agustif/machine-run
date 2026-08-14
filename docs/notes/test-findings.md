# Test findings

Bugs surfaced by writing reconciler-level tests against the real exported
logic. **All three below have since been fixed**, and each pinning test was
flipped to assert the corrected behaviour rather than deleted — so a
regression re-breaks a test instead of silently passing.

| Finding | Fix |
|---|---|
| `Tailscale.Connection.observe` decoded the whole `{exitCode, stdout, stderr}` result instead of `stdout`, so every decode failed, a connected daemon always read as absent, and `apply`'s "already connected" branch was dead code | decodes `result.stdout` |
| `Machine.File` and `Machine.SecretFile` `observe` folded every `fs.stat` failure into "absent", including permission errors — the anti-pattern AGENTS.md rule 11 names, which `Machine.Symlink` already guarded against | typed `FilePathUnreadable` / `SecretFilePathUnreadable`, distinguishing `NotFound` from everything else |
| `Machine.SecretFile` never set `snapshotBeforeApply`, so a hand-placed key at a managed path was overwritten with no copy | opts into the gate |

The original write-ups follow.

---

# Test findings

Real `src` bugs surfaced while writing reconciler-level tests for
`packages/dotfiles`, `packages/secrets`, `packages/macos-defaults` and
`packages/tailscale`. Per this session's scope, none of these were fixed —
each is pinned by a test that documents the *current* (buggy) behaviour, with
a comment pointing at what should flip if the underlying code is ever fixed.

## 1. `Tailscale.Connection`'s `observe` decodes the wrong value — it can never see a connected daemon

`packages/tailscale/src/Connection.ts`, `observe`:

```ts
observe: (_props, ctx) =>
  ctx.exec({ command: "tailscale status --json" }).pipe(
    Effect.flatMap(decodeStatus),
    ...
```

`ctx.exec(...)` resolves to the whole `CommandOutput` shape —
`{ exitCode, stdout, stderr }` — but `decodeStatus` is
`Schema.decodeUnknownEffect` over `Schema.fromJsonString(...)`, which only
accepts a JSON **string**. It is never handed `result.stdout`; it is handed
the wrapper object. Decoding an object where a string is expected fails
immediately with a `SchemaError`.

That failure is caught right below:

```ts
Effect.catchTag("SchemaError", () => Effect.succeed(undefined)),
```

which is the correct thing to do for output that genuinely won't parse — but
here it silently swallows *every* successful invocation. The net effect,
verified directly (`packages/tailscale/test/Connection.test.ts`,
`"BUG: observe reports absent even for a live, connected daemon..."`):
handing `observe` a perfectly valid, running-and-authenticated
`tailscale status --json` payload still returns `undefined`.

Consequences:

- `diff` always reports drift for a connected machine, because `observed` is
  always `undefined`.
- `apply`'s "already on the tailnet" branch (`observed !== undefined`) is
  **dead code** — it can never be taken through this path, so `apply` always
  takes the `tailscale up --authkey=...` branch and re-authenticates on every
  single deploy, unconditionally, rather than only moving the hostname when
  already connected.
- `hostname` drift detection (`matches`) is unaffected in isolation (it's
  pure), but never gets a real `observed` value to compare in practice.

Fix sketch (not applied — out of scope for this task): decode
`result.stdout`, not `result`, e.g. `Effect.flatMap((result) =>
decodeStatus(result.stdout))`.

Pinned by: `packages/tailscale/test/Connection.test.ts` ›
`"BUG: observe reports absent even for a live, connected daemon, because it
decodes the whole CommandOutput instead of \`stdout\`"`.

## 2. `Machine.File` and `Machine.SecretFile` collapse *any* stat failure into "absent" — including a permission error

`packages/dotfiles/src/File.ts` and `packages/secrets/src/SecretFile.ts`,
both in `observe`:

```ts
const info = yield* fs.stat(target).pipe(Effect.orElseSucceed(() => undefined));
if (info === undefined) return undefined;
```

Any `fs.stat` failure — not just "the path genuinely does not exist" — is
folded into "nothing here yet". AGENTS.md rule 11 calls this exact pattern
out as a documented anti-pattern ("`Effect.option` over a `readLink` turned
permission errors into 'no symlink here' and produced a misleading second
failure"), and `packages/dotfiles/src/Symlink.ts` in the very same package
does the right thing next to it: it disambiguates `NotFound` from every other
failure reason and raises a typed `SymlinkPathUnreadable` for the rest.
`File.ts` and `SecretFile.ts` never got the same treatment.

Verified directly:

- `packages/dotfiles/test/File.test.ts` ›
  `"BUG: observe reports absent (not a permission error) when the parent
  directory is unreadable"` — a file sitting behind a `chmod 000` parent
  directory is reported as absent, not as a typed failure.
- `packages/secrets/test/SecretFile.test.ts` › the same test name — same
  root cause, worse consequence: `apply` proceeds to fetch the secret from
  its backend and write it, touching the vault for an operation whose result
  can't even be verified to have landed.

Consequences: a directory whose ownership or permissions changed underneath
this tool (a `~/.ssh` set up by someone else, a mounted volume with the wrong
owner) is read as "create it fresh" rather than surfacing the real problem,
and `apply`'s subsequent `mkdir -p`/write attempt fails with whatever raw
`EACCES` the filesystem call surfaces, several frames away from the actual
cause `observe` already knew about and threw away.

Fix sketch (not applied): mirror `Symlink.ts`'s `currentTarget`/`isNotFound`
pattern — `fs.stat(target).pipe(Effect.catchTag("PlatformError", (cause) =>
isNotFound(cause) ? Effect.succeed(undefined) : Effect.fail(new
<ResourcePathUnreadable>({ path: target, cause }))))`.

## 3. `Machine.SecretFile` never sets `snapshotBeforeApply` — pre-existing secrets are overwritten with no backup

`packages/secrets/src/SecretFile.ts`'s reconciler object has no
`snapshotBeforeApply` field at all, unlike `Machine.File` and
`Machine.Symlink` (both `snapshotBeforeApply: true`) in the neighbouring
`dotfiles` package. Its `apply` unconditionally does:

```ts
yield* fs.writeFileString(desired.path, content, { mode: desired.mode });
```

— the same "this tool overwrites whatever is at this path" shape that
`snapshotBeforeApply`'s doc comment describes as exactly the case it's for:
"anything that overwrites a file a person may have written by hand." A
person who hand-placed an SSH key or token at a path a recipe is later
pointed at gets it silently and irreversibly overwritten on the resource's
first apply (or the first apply after adoption) — with **no** backup taken,
where the equivalent situation for `Machine.File`/`Machine.Symlink` is
protected by the engine's adoption-backup gate in `toProvider`.

Verified directly: `packages/secrets/test/AdoptionSnapshot.test.ts` ›
`"does NOT snapshot pre-existing, hand-placed content before overwriting it —
snapshotBeforeApply is unset"` — a fake `Backups.snapshot` counter stays at
`0` across a first apply that overwrites real, pre-existing file content.
Contrast with `packages/dotfiles/test/AdoptionSnapshot.test.ts`, which proves
the same gate *does* fire for `Machine.File` in the identical scenario
(first apply, first apply after adoption) and does *not* fire on a routine
update — i.e. the gate itself works correctly; `SecretFile` simply never
opts into it.

Fix sketch (not applied): add `snapshotBeforeApply: true` to
`makeSecretFileReconciler`'s returned object. Worth a second look before
doing so, though: backing up a *secret's* plaintext into
`~/.local/state/machine-run/backups/` — an unencrypted location outside this
tool's control — may not be the right answer even so; see AGENTS.md §8
("Secrets never touch state"). A real fix may need to snapshot only when the
pre-existing file's content doesn't look like a value this tool would ever
produce, or accept the current gap as deliberate and say so in
`SecretFile.ts`'s doc comment instead — either way, this is a decision for
whoever owns `packages/secrets/src`, not something to fix silently under a
test-only task.

## 4. Resolved: `KeychainBackend.read` once returned hex text for non-printable bytes

`packages/secrets/src/backends/Keychain.ts`, `read` (the original finding):

```ts
Effect.map((result) => Redacted.make(result.stdout.replace(/\n$/, ""))),
```

`security find-generic-password -w` — the flag this backend uses — prints
the **ASCII-hex encoding of the stored bytes, not the bytes themselves**,
whenever the stored value contains a byte outside `isprint()`'s range.
Verified directly on real macOS (2026-08-14, disposable test keychain, never
the login keychain): a value with embedded newlines came back as
`6c696e65310a6c696e65320a6c696e6533` (the correct bytes, but hex-encoded as
ASCII text) instead of the literal three-line string that was stored; a
value with a single embedded tab showed the identical behaviour. A
plain single-line ASCII value, with or without embedded spaces, round-trips
correctly. Exit code is `0` in both cases — nothing signals that the
fallback encoding kicked in.

Consequences: any secret this tool is likely to actually store in a
keychain and later need to write out — an SSH private key, a PEM
certificate, a multi-line token, anything `Machine.SecretFile` exists to
place at `0o600` — comes back corrupted (as its own hex encoding) rather
than failing loudly. There is no reliable way to detect this from `-w`'s
output alone after the fact: a hex-looking string is inherently ambiguous
between "this is the fallback encoding" and "this genuinely is the secret,
and it happens to look like hex."

The fix is now applied:
`security find-generic-password -g` disambiguates the two cases
(`password: 0x<hex>` for the raw-byte fallback vs. a bare `password:
"quoted string"` for the printable case, confirmed against the same two
entries). `read` now switches from `-w` to `-g`, parses both forms, and the
regression suite verifies the decoded value is byte-exact and remains redacted.

Pinned by: `packages/secrets/test/Keychain.test.ts` and
`packages/secrets/test/fixtures/keychain-g-flag-transcript.txt`. See also
`docs/notes/secrets-keychain-notes.md` and
`packages/secrets/test/fixtures/keychain-multiline-hex-stdout.txt` for the
original captured session.
