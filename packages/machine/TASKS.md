# `@machine-run/machine` — backlog

The single aggregate providers layer. Its whole value is that a recipe cannot
forget a package's `providers()`, so it is only correct while it is complete.

- [ ] Decide whether core services should be `provideMerge`d (visible in the
      layer's output) or `provide`d (hidden). Exposing them makes the layer's
      type wider than `ProviderServices`, which Alchemy's `StackProps` is
      strict about.
