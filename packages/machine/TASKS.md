# `@machine-run/machine` — backlog

The single aggregate providers layer. Its whole value is that a recipe cannot
forget a package's `providers()`, so it is only correct while it is complete.

- [x] **Add every package that defines a resource.** All ten are merged today:
      `ai`, `dotfiles`, `git`, `macos-defaults`, `runtimes`, `secrets`, `shell`,
      `system-packages`, `system-settings`, `tailscale`, plus `coreServices()`
      and `CommandExecutorLive()`. `@machine-run/ssh` is deliberately absent
      because it defines no resource — it composes `dotfiles` ones — and that
      stays correct only until `Ssh.Key` lands. See
      `packages/ssh/TASKS.md`.
- [ ] **A test that fails when a package is missing from the merge.** The
      current smoke test proves the layer _resolves_; it cannot notice that a
      newly added package was never included. Enumerating the workspace and
      asserting every resource-defining package appears would close the gap
      that the aggregate exists to close.
- [ ] Decide whether core services should be `provideMerge`d (visible in the
      layer's output) or `provide`d (hidden). Exposing them makes the layer's
      type wider than `ProviderServices`, which Alchemy's `StackProps` is
      strict about.
