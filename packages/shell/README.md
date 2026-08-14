# `@machine-run/shell`

Reconciles the login shell itself, and renders rc-file content — environment
variables, `PATH` entries, aliases, functions, directory-change hooks — across
five interactive shells with genuinely different syntax.

## What it exports

| Resource      | Reconciles                                                                        |
| ------------- | --------------------------------------------------------------------------------- |
| `Shell.Login` | the login shell (`chsh`), including its own `unapply` — the only one in this repo |

| Composition               | What it does                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `envVar`                  | one exported environment variable, rendered for `props.shell`'s syntax                                                                              |
| `pathEntry`               | one `PATH` entry, deduplicated by whichever mechanism the shell uses natively                                                                       |
| `alias`                   | one alias (or fish/nu's nearest equivalent)                                                                                                         |
| `func`                    | a named shell function — for what `alias` can't express: a body taking positional arguments                                                         |
| `hook`                    | a directory-change hook, rendered through each shell's own mechanism (`chpwd_functions`, `PROMPT_COMMAND`, `--on-variable PWD`, `hooks.env_change`) |
| `ensureLoginShellLoadsRc` | bridges a login shell (zsh, bash) to also load its interactive rc file                                                                              |

Every composition is a plain function over `@machine-run/dotfiles`'s
`Machine.ManagedBlock`, not a `Resource` of its own — `shell` is a required
prop on each rather than inferred, because `export FOO=bar` in zsh is
`set -gx FOO bar` in fish and `$env.FOO = "bar"` in nu.

**Note on `docs/MAP.md`:** its §3 compositions table lists `envVar · pathEntry
· alias · hook · ensureLoginShellLoadsRc` but omits `func`, which is a real,
exported composition (`src/Profile.ts`) with its own backend-seam method
(`ShellBackend.renderFunction`) and its own tests. It is also not yet
exercised in `examples/complete-machine`. Worth fixing in both places.

## Example

From
[`examples/complete-machine/recipes/shell.ts`](../../examples/complete-machine/recipes/shell.ts):

```ts
import * as Shell from "@machine-run/shell";

// The login shell itself, via `chsh`. An absolute path, not a shell id: fish,
// nu and pwsh have no fixed install location to infer.
yield * Shell.Login("login-shell", { shell: "/bin/zsh" });

yield * Shell.envVar("editor", { shell: "zsh", name: "EDITOR", value: "nvim" });

// A directory-change hook. Each shell has its own mechanism, which the
// backend renders.
yield *
  Shell.hook("hook-node-version", {
    shell: "zsh",
    name: "use_node_version",
    pathGlob: "$HOME/code/*",
    command: "mise install",
  });

// A login shell reads its login file, not its rc file, so interactive config
// placed only in `.zshrc` never loads in a login shell.
yield * Shell.ensureLoginShellLoadsRc("zsh-login-loads-rc", { shell: "zsh" });
```

## Verification status

The best-verified backend seam in the repo —
[../../docs/MAP.md](../../docs/MAP.md) §4 marks all five (`zsh`, `bash`,
`fish`, `nu`, `pwsh`) `✓`, each exercised live in a container (`nu`
0.114.1, `pwsh` 7.4.2), including `func`/`renderFunction`, verified by
defining a real two-argument function per shell and reading the arguments
back correctly. That verification is what found bash's real login-shell
behaviour: bash does not read `.bashrc` in a login shell, so a hook written
there never fires for Terminal.app or `ssh` — the reason
`ensureLoginShellLoadsRc` exists at all.

Two real gaps: nu's chdir hook (`hooks.env_change.PWD`) is verified to
_register_, but _firing_ it needs a TTY a container can't supply, so that was
never confirmed. And `pwsh` was verified inside a Linux container, not on real
Windows, where its profile path differs (`Documents\PowerShell` vs.
`.config/powershell`) — that path is the entire thing the backend contributes.

## What it deliberately does not do

- **`Shell.Login` is the only resource in this repo with `unapply`.** It
  restores whatever shell `observe` recorded before this resource's first
  apply — but that `unapply` itself has never run under a real `destroy`,
  because no `destroy` has ever run against a real Alchemy engine.
- **No completion registration, prompt, or theme.** Every shell here has a
  completions mechanism and nothing models it; starship/oh-my-zsh/oh-my-posh
  are each their own ecosystem and are deliberately out of scope so far.
- **`rcPath` overrides are unguarded.** Every composition takes an optional
  `rcPath` overriding the backend's default rc file, and nothing warns when
  that silently targets a file the backend doesn't consider its own.

See [TASKS.md](./TASKS.md) for the rest.
