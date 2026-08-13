# `@machine-run/secrets` — backlog

`Machine.SecretFile` over a `SecretBackend` seam. Backends are plain values
that receive a command runner; nothing here needs a service.

- [x] **`pass` now reads a real secret.** Verified against `docker run --rm
debian:stable`: a generated GPG key, `pass init`, `pass insert -m`, and
      `pass show` reading both a single-line and a multi-line entry back
      correctly — see `docs/notes/secrets-pass-notes.md` and
      `src/backends/Pass.ts`'s doc comment. `pass` is now `✓` in
      [docs/MAP.md](../../docs/MAP.md); the other four backends
      (`1password`, `doppler`, `keychain`, `env`) are still `~` — each needs
      either a real authenticated account (which this repo deliberately never
      automates creating, `AGENTS.md` rule 8) or a real macOS login keychain,
      neither of which a disposable container can supply. This remains the
      least-verified seam in the repo, and it is the one writing `0o600`
      files on the strength of being right.
- [ ] **Verify `op read`'s output shape against a real `op` CLI.** Not installed
      on the development machine, so no output-shaping flag is used and bytes
      are returned verbatim. Confirm whether `op read` appends a newline, then
      document the right `trailingNewline` default per secret kind.
- [ ] **Fixture-based classifier tests for the remaining backends** using real
      captured stderr. `doppler` is installable in a container (no account
      needed just to observe its CLI's own error text for a bad ref); `op` and
      `bw` are not.
- [ ] **`bitwarden` backend.** Deliberately absent from `SecretBackendId` until
      implemented — an id that can be named but not constructed is worse than a
      missing one.
- [ ] **AWS Secrets Manager and HashiCorp Vault backends.** Both are HTTP rather
      than CLI, which the current interface has never been exercised against;
      check whether `read(ref, exec)` still fits or whether the seam needs a
      non-command shape.
- [ ] **Rotation detection.** Currently impossible by construction (see
      V1-PLAN §5). Worth investigating whether stores expose change metadata —
      1Password has item versions — which would detect rotation without ever
      reading the value.
- [ ] **`Machine.SecretEnv`.** Doppler's `run` shape (inject secrets as env vars
      into one command) is genuinely useful and currently unexpressible; it
      belongs on a command-running resource, not on `SecretBackend`.
