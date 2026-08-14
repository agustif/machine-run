# `@machine-run/secrets` — backlog

`Machine.SecretFile` over a `SecretBackend` seam. Backends are plain values
that receive a command runner; nothing here needs a service.

- [ ] **Verify `op read`'s output shape (trailing newline, `--no-newline`)
      against a real vault read.** `op` itself is installed and runs in this
      session's container, but only its unauthenticated error path — a real
      vault read still needs an account this repo deliberately never
      creates. `1password` and `doppler` stay `~` in
      [docs/MAP.md](../../docs/MAP.md) for the same reason: a real
      vault/project read is unverified.
- [ ] **`bitwarden` backend.** Deliberately absent from `SecretSource` until
      implemented — a variant that can be named but not constructed is worse
      than a missing one.
- [ ] **AWS Secrets Manager and HashiCorp Vault backends.** Both are HTTP
      rather than CLI, which the current interface has never been exercised
      against; check whether `read(source, exec)` still fits or whether the
      seam needs a non-command shape.
- [ ] **Rotation detection.** Currently impossible by construction (see
      V1-PLAN §5). Worth investigating whether stores expose change metadata
      — 1Password has item versions — which would detect rotation without
      ever reading the value.
- [ ] **`Machine.SecretEnv`.** Doppler's `run` shape (inject secrets as env
      vars into one command) is genuinely useful and currently
      unexpressible; it belongs on a command-running resource, not on
      `SecretBackend`.
