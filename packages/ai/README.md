# `@machine-run/ai`

Reconciles which MCP servers an AI coding CLI knows about, and makes a
tool's `skills/` directory and a short allowlist of its config files available
by symlinking them from a vault directory you maintain — never by copying, and
never a blanket symlink of a tool's whole config directory.

## What it exports

| Export                                                           | What it's for                                                                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `Ai.McpServer` (`McpServer.ts`)                                  | One named MCP server in one tool's own config file/CLI state                                                             |
| `Ai.aiSkill(props)` / `aiSkills(props)` (`Skill.ts`)             | Symlinks a tool's `skills/` directory to `vaultDir/skills/<tool>`; `aiSkills` is a loop over several tools               |
| `Ai.aiConfig(props)` / `aiConfigs(props)` (`Config.ts`)          | Symlinks each of a tool's individually reviewed config files from `vaultDir/config/<tool>/<file>`                        |
| `AiToolId` (`Backend.ts`)                                        | The closed set of 12 tools this package knows an on-disk layout for                                                      |
| `AiToolBackend` seam (`Backend.ts`, `Store.ts`, `backends/*.ts`) | One module per tool describing its `skillsDir`, `reviewedConfigFiles`, and (for 4 of the 12) its MCP registration format |

`aiSkill`/`aiConfig` are plain compositions over `Dotfiles.Symlink` — not
resources themselves, so they carry no state beyond what `Machine.Symlink`
already reconciles.

## The vault directory, and why this package won't create it for you

`aiSkill`/`aiConfig` never write content — they only symlink to
`vaultDir/skills/<tool>` or `vaultDir/config/<tool>/<file>`, and
`Dotfiles.Symlink` refuses to create a symlink unless `source` already exists
(see `packages/ai/src/Skill.ts` and `Config.ts`'s doc comments). So before
either resource does anything useful, a human has to:

1. Create the vault directory in their own private repo, e.g.
   `~/machine-run/vault/ai/skills/claude/` and
   `~/machine-run/vault/ai/config/claude/<file>`.
2. Copy the real content there **by hand**, reading it first.
3. Commit it to version control.

This is deliberate, not a missing convenience. `~/.claude`, `~/.codex` and the
other tool directories also hold `auth.json`, session tokens, and sqlite
databases that must never enter a git repo — so this package only ever
symlinks a directory or file a human has already reviewed and placed there,
never the tool's config directory wholesale. `reviewedConfigFiles` (see
`Store.ts`) is an explicit per-tool allowlist for exactly this reason: most of
the 12 tools have an empty list today, meaning nothing in their config is
currently considered symlink-safe.

## Example

From `examples/complete-machine/recipes/ai.ts`:

```ts
import * as Ai from "@machine-run/ai";

const vaultDir = "~/machine-run/vault/ai";

// A stdio MCP server — a binary this tool launches.
yield *
  Ai.McpServer("filesystem-claude", {
    tool: "claude",
    name: "filesystem",
    transport: {
      _tag: "Stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/code"],
    },
  });

// A remote MCP server — Stdio and Remote are separate tagged variants, so a
// server can't be written with both a command and a url, or with neither.
yield *
  Ai.McpServer("linear-claude", {
    tool: "claude",
    name: "linear",
    transport: { _tag: "Remote", url: "https://mcp.linear.app/sse" },
  });

yield * Ai.aiSkill({ home: "~", vaultDir, tool: "claude" });
yield * Ai.aiConfig({ home: "~", vaultDir, tool: "claude" });
```

## Verification status

**Not one of the 12 `AiToolBackend`s has been run against its real tool** —
each needs the CLI installed and usually logged in, which this environment
doesn't have (see [../../docs/MAP.md](../../docs/MAP.md) §4). This makes `ai`
the second-least-verified seam in the repo, after `secrets`.

Only 4 of the 12 tools support MCP registration at all here — `claude`,
`codex`, `grok`, and `config-opencode` (`Ai.McpServer`'s `tool` prop is typed
to exactly this subset, so naming one of the other 8 is a compile error, not a
runtime surprise). Of those four, none has had its config file/CLI shape
confirmed against the real tool — `claude`'s and `codex`'s formats were
written from documentation, and `Ai.aiSkill`/`aiConfig`'s targets for `cursor`
and `gemini` are only known to exist on one development machine, with neither
tool's own CLI available to interrogate. `copilot`, `agents`, and the four
`config-*` tools have no MCP support modelled at all — see `Store.ts`'s
`aiToolBackends` registry and `backends/Basic.ts`'s doc comment for exactly
what was and wasn't checked.

## What it deliberately does not do

- **Never copies or generates vault content.** See above — a missing skill or
  config file is a setup step, not a bug.
- **`Ai.aiSkill`/`aiConfig` are compositions, not resources**, so they can't
  express "this directory should contain exactly these files" — an extra file
  dropped in by hand is invisible to them. That's the same reviewed-allowlist
  posture the design intends, not an oversight.
- **User-global config only.** All 12 backends address a tool's global config;
  none reaches a project-local config file.
- **Never resolves a secret to decide if a config is valid.** `McpEnvValue`
  accepts a `SecretSource` reference in `env`/`headers`, but nothing checks the
  reference actually resolves before writing a config that could fail at tool
  startup.

See [TASKS.md](./TASKS.md) for the rest of the backlog.
