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

- [x] **`deploy` and `destroy`.** Both exist now (`deployRecipe`/
      `destroyRecipe` in `Commands.ts`, wired up in `Cli.ts`). Built directly
      on `Stack.evalStack` + `Plan.make`/`Plan.destroy` + `Apply.apply` — the
      same shape `Alchemy.deploy`/`Alchemy.destroy` use internally
      (`node_modules/alchemy/lib/Deploy.js`, `Destroy.js`), rather than calling
      those exports, since their signatures pin the stack's error type to
      `ConfigError` and this package's `Recipe` type does not. Both refuse
      without `--yes`, checked before the recipe is even resolved, so a
      missing `--yes` never builds `withStackServices`' layer (which creates
      `.alchemy` on disk as a side effect of merely being provided).
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
