# `@machine-run/cli` — backlog

`machine-run plan` — plans a recipe without going through `alchemy plan`.

`alchemy plan` fails silently for any recipe built with
`Alchemy.Stack<{}>()(name, options, effect)`: the no-argument call returns a
cross-stack *reference* builder rather than building a stack, discarding
`options` and `effect`, and the failure surfaces four layers away as
`Fiber.runLoop: Not a valid effect: undefined` with empty stdout and stderr.
Full chain in [docs/notes/plan-blocker-repro.md](../../docs/notes/plan-blocker-repro.md);
`Recipe.ts`'s `RecipeIsStackReference` catches it directly.

## Open

- [ ] **`deploy` and `destroy`.** Only `plan` is exposed. `Alchemy.deploy`/
      `Alchemy.destroy` (`node_modules/alchemy/lib/Deploy.js`, `Destroy.js`) are
      one-line wrappers over `Stack.evalStack`, the same shape `Commands.ts`'s
      `planRecipe` already uses — the missing piece is a `Cli` service
      (`approvePlan`, `displayPlan`, `startApplySession`) for `Apply.apply` to
      call into. Alchemy ships `LoggingCli` as a non-TUI reference worth
      reading first.
- [ ] **Report the `Stack()`-with-no-arguments trap upstream.** A call that
      type-checks, silently discards its own arguments, and fails four layers
      away with a message naming neither the recipe nor the call is a
      foot-gun regardless of whose recipe triggers it.
- [ ] **Test the `plan` path end to end.** `Diagnostics.test.ts` covers the
      reporting contract and `Recipe.test.ts` covers recipe loading; nothing
      exercises `Commands.ts`'s `planRecipe` itself.
- [ ] **A recipe that exports the wrong thing is only partly caught.**
      `RecipeNotAStack` catches a missing or primitive default export and
      `RecipeIsStackReference` catches the no-args-`Stack()` trap; neither can
      tell a compiled stack from any other object without duplicating
      Alchemy's own judgement.
