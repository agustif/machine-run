# `@machine-run/machine` — backlog

The single aggregate providers layer. Its whole value is that a recipe cannot
forget a package's `providers()`, so it is only correct while it is complete.

- [x] **Add every package that defines a resource.** All ten are merged today:
      `ai`, `dotfiles`, `git`, `macos-defaults`, `runtimes`, `secrets`, `shell`,
      `system-packages`, `system-settings`, `tailscale`, plus `coreServices()`
      and `CommandExecutorLive()`. `@machine-run/ssh` and `@machine-run/system-services` are
      included too — ssh gained `Ssh.Key` and `Ssh.KnownHost`, and
      `AggregateCompleteness.test.ts` demanded both the moment they existed.
- [x] **A test that fails when a package is missing from the merge.** Closed by
      `test/AggregateCompleteness.test.ts`. It reads source rather than
      resolving the layer, because a `Layer` carries no runtime list of what it
      provides and a type-level check would only cover resources a test file
      happened to name — the same gap one level up. A package earns its way in
      by defining a `Resource<T>(...)`, so composition-only packages like
      `@machine-run/ssh` are correctly absent until they gain one.
- [ ] Decide whether core services should be `provideMerge`d (visible in the
      layer's output) or `provide`d (hidden). Exposing them makes the layer's
      type wider than `ProviderServices`, which Alchemy's `StackProps` is
      strict about.
