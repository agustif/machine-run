# `@machine-run/secrets` — backlog

`Machine.SecretFile` over a `SecretBackend` seam. Backends are plain values
that receive a command runner; nothing here needs a service.

- [ ] **Verify `op read`'s output shape against a real `op` CLI.** Not installed
      on the development machine, so no output-shaping flag is used and bytes
      are returned verbatim. Confirm whether `op read` appends a newline, then
      document the right `trailingNewline` default per secret kind.
- [ ] **Fixture-based classifier tests** using real captured stderr. `pass` and
      `doppler` are installable in a container; `op` and `bw` are not.
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
