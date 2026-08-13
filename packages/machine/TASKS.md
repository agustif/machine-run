# `@machine-run/machine` — backlog

The single aggregate providers layer. Its whole value is that a recipe cannot
forget a package's `providers()`, so it is only correct while it is complete.

- [ ] **Add every package that defines a resource**, as each lands:
      `@machine-run/git`, `@machine-run/ai`, `@machine-run/shell`,
      `@machine-run/system-settings`, `@machine-run/runtimes`. A missing entry
      shows up as a compile error at the recipe (`Provider<X>` not satisfied),
      which is the failure mode this package converts a silent runtime error
      into — but only for resources someone actually uses.
- [ ] **A test that fails when a package is missing from the merge.** The
      current smoke test proves the layer _resolves_; it cannot notice that a
      newly added package was never included. Enumerating the workspace and
      asserting every resource-defining package appears would close the gap
      that the aggregate exists to close.
- [ ] Decide whether core services should be `provideMerge`d (visible in the
      layer's output) or `provide`d (hidden). Exposing them makes the layer's
      type wider than `ProviderServices`, which Alchemy's `StackProps` is
      strict about.
