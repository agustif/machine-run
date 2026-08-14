# `@machine-run/secrets` — backlog

`Machine.SecretFile` over a `SecretBackend` seam. Backends are plain values
that receive a command runner; nothing here needs a service.

- [x] **`SecretFileProps.source` is a typed `SecretSource` union, not a string
      discriminator plus an opaque `ref: Schema.String`.** `{ source:
"1password", ref: "GITHUB_TOKEN" }` used to type-check while being
      nonsense — one field's grammar depended entirely on its sibling's value,
      and nothing caught a ref shaped for the wrong store. `SecretSource` is
      now a `Schema.TaggedUnion` (`Backend.ts`) with one properly-named-field
      variant per store — `OnePassword { vault, item, field }`, `Doppler {
project, config, name }`, `Keychain { service, account? }`, `Pass {
path }`, `Env { variable }` — dispatched exhaustively in `Store.ts` via
      `Match.tagsExhaustive`, and each `SecretBackend`'s `read` is narrowed to
      the one variant it accepts, so handing a backend a reference shaped for
      a different store is now a compile error. This is a props-and-state
      schema break with no migration: nothing built on the old shape has ever
      been deployed against a real machine. Doppler's `parseRef` and
      Keychain's `splitRef` are gone entirely — their grammars are separate
      typed fields now, not a string this package parsed itself.
- [ ] **`packages/state`, `packages/tailscale` and `packages/ai` still import
      the pre-refactor `SecretBackendId`/`secretBackend`/`{ source, ref }`
      shape** (`state/src/DataKey.ts`, `tailscale/src/Connection.ts`,
      `ai/src/McpServer.ts`) and will not build until each is moved onto
      `SecretSource`/`readSecret`. Out of scope for this package's own
      refactor; each needs its own pass.
- [x] **`pass` now reads a real secret.** Verified against `docker run --rm
debian:stable`: a generated GPG key, `pass init`, `pass insert -m`, and
      `pass show` reading both a single-line and a multi-line entry back
      correctly — see `docs/notes/secrets-pass-notes.md` and
      `src/backends/Pass.ts`'s doc comment. `pass` is `✓` in
      [docs/MAP.md](../../docs/MAP.md).
- [x] **`env` verified with no account and no CLI at all.** `Config.redacted`
      against the real, unmocked default `ConfigProvider` inside `docker run
--rm -e MACHINE_RUN_TEST_SECRET=... node:22-slim` (this repo's pinned
      `effect@4.0.0-rc.108`): a set variable round-tripped its exact literal
      value, an unset one failed with a real `ConfigError`. See
      `docs/notes/secrets-env-notes.md`. `env` is `✓` in
      [docs/MAP.md](../../docs/MAP.md).
- [x] **`op`/`doppler`'s `SecretAuthRequired` classification checked against
      real, unauthenticated CLIs — and both had a real gap, now fixed.**
      `op read` with zero accounts configured (`docker run --rm
debian:stable` + the official 1Password apt repo) produces `No
accounts configured for use with 1Password CLI.`, which matched none
      of `classify`'s three original substrings. `doppler secrets get` with
      no token produces `Doppler Error: you must provide a token`, which
      likewise matched neither of its two. Both real "not authenticated"
      states used to fall through to the generic `SecretReadFailed` bucket
      instead of `SecretAuthRequired`; both classifiers now also match these
      real captured strings, pinned in `test/OnePassword.test.ts` /
      `test/Doppler.test.ts`. See `docs/notes/secrets-op-notes.md` and
      `docs/notes/secrets-doppler-notes.md`. A real vault/project read is
      still unverified (needs an authenticated account this repo
      deliberately never creates, `AGENTS.md` rule 8) — `1password` and
      `doppler` stay `~` in [docs/MAP.md](../../docs/MAP.md).
- [x] **`keychain`'s hex-corruption bug fixed: `KeychainBackend.read` now
      reads via `-g`, not `-w`.** `security find-generic-password -w`
      printed the ASCII-hex encoding of the stored bytes, not the bytes,
      whenever the value contained a byte outside `isprint()`'s range —
      exactly the shape of an SSH key, a PEM cert, or any multi-line secret,
      with exit code `0` and no signal anything went wrong. `read` now shells
      out with `-g` instead and parses both forms it can produce: `password:
      0x<hex>` (decoded directly — the ground truth) and a bare `password:
      "quoted string"` for the printable case. Verified against a disposable
      test keychain on real macOS (never the login keychain): a plain
      value, an embedded newline, an embedded tab, a realistic multi-line
      PEM-shaped blob (with and without its own trailing newline), and
      values built to probe the quoted form's escaping (an embedded quote,
      an embedded backslash, a UTF-8 value) all round-trip exactly. Two
      findings along the way: a literal backslash alone (no non-printable
      byte) also triggers the `0x` fallback, and the bare quoted form never
      escapes an embedded double quote — parsed correctly anyway since the
      outer quotes are always the line's first and last characters. The
      missing-entry exit `44`/stderr signal `SecretNotFound` depends on was
      re-verified unchanged under `-g`. See
      `test/fixtures/keychain-g-flag-transcript.txt`, `src/backends/
      Keychain.ts`'s doc comment, and `test/Keychain.test.ts`. `keychain`'s
      successful-read path can move from `!` to `✓` in
      [docs/MAP.md](../../docs/MAP.md) as a follow-up (out of this fix's
      scope, which was limited to `packages/secrets/`).
- [ ] **Verify `op read`'s output shape (trailing newline, `--no-newline`)
      against a real vault read.** `op` itself is now installed and run in
      this session's container, but only its unauthenticated error path —
      a real vault read still needs an account this repo deliberately never
      creates. Confirm whether `op read` appends a newline, then document
      the right `trailingNewline` default per secret kind.
- [ ] **`bitwarden` backend.** Deliberately absent from `SecretSource` until
      implemented — a variant that can be named but not constructed is worse
      than a missing one.
- [ ] **AWS Secrets Manager and HashiCorp Vault backends.** Both are HTTP rather
      than CLI, which the current interface has never been exercised against;
      check whether `read(source, exec)` still fits or whether the seam needs a
      non-command shape.
- [ ] **Rotation detection.** Currently impossible by construction (see
      V1-PLAN §5). Worth investigating whether stores expose change metadata —
      1Password has item versions — which would detect rotation without ever
      reading the value.
- [ ] **`Machine.SecretEnv`.** Doppler's `run` shape (inject secrets as env vars
      into one command) is genuinely useful and currently unexpressible; it
      belongs on a command-running resource, not on `SecretBackend`.
