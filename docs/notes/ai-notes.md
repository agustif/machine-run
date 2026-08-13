# ai / ai-tools notes

`@machine-run/ai` replaces `@machine-run/ai-tools`'s two frozen arrays and a
`for` loop with a real backend seam (`AiToolBackend`, one module per tool,
dispatched by id — see `packages/ai/src/Backend.ts` and `Store.ts`) and adds
`Ai.McpServer`, which the old package never had.

## Verified on this machine vs. not

This machine has `claude`, `codex`, `grok`, and `opencode` installed and on
`PATH`. Every fixture used in `packages/ai/test/` is real captured output —
either the tool's own CLI run against an isolated `$HOME`/`$CODEX_HOME` (never
the operator's real config), or, for opencode, corroborated further by the
installed `@opencode-ai/sdk` package's own `McpLocalConfig`/`McpRemoteConfig`
type declarations. No fixture was invented.

MCP registration backends exist (`AiMcpBackend` populated) for exactly these
four — `AiMcpToolId` is a closed literal set restricted to them, so naming a
fifth is a compile error, not a runtime `AiToolMcpUnsupported`:

- **claude** — JSON file, `~/.claude.json`, top-level `mcpServers` key
  (user scope). Verified via `claude mcp add-json`/`claude mcp add --transport
  http ... -s user` against an isolated `$HOME`.
- **codex** — TOML, `~/.codex/config.toml`, `[mcp_servers.<name>]` table.
  Verified via `codex mcp add`/`codex mcp get --json` against an isolated
  `$CODEX_HOME`. Remote servers only support a bearer-token env var, not
  arbitrary headers (`codex mcp add --help` has no `--header`) — a `headers`
  prop for this tool fails with a typed `AiToolFieldUnsupported` rather than
  being silently dropped.
- **grok** — TOML, `~/.grok/config.toml`, structurally the same
  `[mcp_servers.<name>]` shape as Codex. Verified via `grok mcp add`/`grok mcp
  list --json` against an isolated `$HOME`. Unlike Codex, `grok mcp add
  --transport http` does take `-H "Name: Value"` headers.
- **config-opencode** — JSON(C), `~/.config/opencode/opencode.jsonc`,
  top-level `mcp` key. Field names diverge from every other backend here
  (`command` is the whole argv as one array; env vars are `environment`, not
  `env`) — genuinely a different shape per tool, which is the whole reason
  this seam exists. Verified via `opencode mcp add` against an isolated
  `$HOME`.

**Not represented as MCP candidates at all**, because neither a CLI nor public
documentation could be checked from this machine: `copilot`, `agents`, and the
four `~/.config/<tool>` families (`agents`, `crush`, `forge`, `goose`).

**Known to be installed here but *not* given an MCP backend**, because their
directories/skills exist (`~/.cursor/skills`, `~/.gemini/skills`) but neither
tool's CLI was present to interrogate, and neither had a live MCP config file
to read the real shape from: `cursor`, `gemini`. Both are publicly documented
as using a `mcpServers`-keyed JSON file (the same shape Claude Code and
Claude Desktop use), but "documented elsewhere" is not "grounded here" per
AGENTS.md rule 5 — don't add either without a real install or a captured
config file to check against.

## Why Codex and Grok are CLI-driven, not file-parsed

No TOML library is installed in this workspace, and adding one would need an
`npm install` this session couldn't run (see below). Rather than hand-roll a
TOML parser — a real risk of corrupting hand-written config in ways worse
than trusting the vendor's own writer — `backends/Codex.ts` and
`backends/Grok.ts` shell out to the tool's own `add`/`get`/`list` lifecycle,
verified to be a real, idempotent "add-or-update": `codex mcp add`/`grok mcp
add` on an existing name updates it in place rather than duplicating it. A
probe against this machine's real `~/.codex/config.toml` (run through `codex
mcp add` against a copy) showed the CLI's own writer drops an explicit `args
= []` and reformats `startup_timeout_sec = 120` as `120.0` — lossy, but that
lossiness belongs to `codex`'s own writer, not to this backend; it is exactly
what would happen if the operator ran the command by hand.

Claude Code and opencode, by contrast, use plain JSON(C) — Effect's `Schema`
already handles that boundary, so `backends/Claude.ts`/`backends/OpenCode.ts`
read/decode/merge/write the document directly rather than shelling out.

If a TOML library is added to this workspace later, `Codex.ts`/`Grok.ts`
could switch to direct file editing the same way — nothing about the
`AiMcpBackend` interface assumes one approach or the other.

## Secret-shaped env/header values

`Ai.McpServer`'s `env`/`headers` props accept a plain string *or* `{ source,
ref }` — the same posture `Machine.SecretFile` and `Tailscale.Connection`
already use, and for the same reason: Alchemy persists props to
`localState()` as unencrypted JSON, so a literal secret typed directly into
`env` would sit in plaintext state forever.

Persisted attributes (`McpServerState`) never carry a secret-sourced value —
only which keys are declared (`envKeys`/`headerKeys`) and the literal
(non-secret) subset's actual values (`envLiteral`/`headerLiteral`). The
honest consequence, mirroring `SecretFileState`'s documented tradeoff exactly:
a secret rotated behind an unchanged `ref` is undetectable by this resource,
because detecting it would mean comparing a resolved secret value inside
`matches`, which must never happen. Covered by
`packages/ai/test/McpServer.test.ts`'s two secret-specific tests.

For the CLI-driven backends (Codex, Grok), a secret-sourced value is passed
to `Exec`'s `env` as `Redacted` and referenced from the constructed command
string as `"$<var>"`, so it never passes through this package's own
string-building as plaintext — see `backends/cliMcp.ts`'s `metaToken` doc
comment. It is still, briefly, visible in the spawned `codex`/`grok`
process's own argv once the shell expands it — a property of any CLI that
accepts a secret as a flag at all, not something this backend adds. The
file-writing backends (Claude, opencode) have no such option: the config file
itself must hold the resolved plaintext value, exactly like `Machine.SecretFile`
writing a resolved secret to disk, so they unwrap `Redacted` immediately
before serializing and nowhere else.

## `opencode.jsonc` is parsed as plain JSON

The real file on this machine (`~/.config/opencode/opencode.jsonc`) has no
`//`/`/* */` comments, and this backend's `readDocument` calls `JSON.parse`
directly. A config that genuinely uses comments fails to decode with a typed
`AiToolConfigMalformed` rather than having them silently eaten by a
hand-rolled stripper. No JSONC-aware parser is installed in this workspace;
add one (and switch `OpenCode.ts` to it) before relying on this backend
against a `opencode.jsonc` that actually uses comments.

## Vault layout changed for config files

The old `ai-tools` vault laid out reviewed config files flat:
`<vaultDir>/config/<file-id>` (`codex-config`, `codex-agents-md`, ...). The
new `Ai.Config` composition nests per tool instead: `<vaultDir>/config/<tool>/
<file>` (e.g. `<vaultDir>/config/codex/config.toml`,
`<vaultDir>/config/codex/AGENTS.md`), because a tool can now declare more than
one reviewed file (`AiToolBackend.reviewedConfigFiles` is an array).
`Ai.Skill`'s layout is unchanged: `<vaultDir>/skills/<tool>`, same as before.

Nothing in this repo has ever been deployed (see AGENTS.md rule 14), so there
is no live vault content to migrate — this is a note for whenever one exists,
not a breaking change against anything real.

## `ai-tools` should be removed before 1.0

> **RESOLVED since this note was written.** The package has been deleted.

`packages/ai-tools/src/Vault.ts` is now a thin shim re-exporting
`@machine-run/ai`'s registry under its old names (`aiTools`,
`aiToolSkills`, `aiToolConfigFiles`, `AI_TOOL_SKILLS_DIRS`,
`AI_TOOL_CONFIG_FILES`), kept only so nothing importing
`@machine-run/ai-tools` today breaks — nothing in this repo actually does
except a commented-out line in `examples/example-machine/alchemy.run.ts`.
New code should depend on `@machine-run/ai` directly; delete `ai-tools`
once that comment (or anything else) is updated to do so.

## Root wiring this package needs from outside its own directory

This session could not edit root `tsconfig.json`, root `package.json`, or run
`npm install`, per instructions. What exists now, entirely inside
`packages/ai/`'s and `packages/ai-tools/`'s own files:

- `packages/ai/package.json` + `packages/ai/tsconfig.json` (new package).
- `packages/ai-tools/package.json` / `tsconfig.json` gained a dependency +
  project reference on `@machine-run/ai`.
- `packages/ai/.oxlintrc.json` — a package-local override (oxlint supports
  nested config files) turning `effect/noGlobals` and
  `effect/noUnsafeDictionaryType` off for exactly `backends/Claude.ts` and
  `backends/OpenCode.ts`, the two files that read/write a tool's config
  document whose non-`mcpServers`/non-`mcp` keys are deliberately unparsed
  and passed through verbatim — the "named adapter file, disable only the
  relevant rule there" pattern `oxlint-plugin-effect`'s own README
  documents for platform boundaries. It also restates the root config's
  `test/**` override locally, since nested `overrides` arrays replace rather
  than merge with the extended parent's.

Still needed, from someone who can touch root files:

1. Add `{ "path": "packages/ai" }` to root `tsconfig.json`'s `references`.
2. Add `{ "path": "packages/ai" }` to root `tsconfig.tests.json`'s
   `references`, so `packages/ai/test/**` is included in the aggregate
   `npx tsc -b` the same way every other package's tests are. Verified by a
   scratch tsconfig mirroring `tsconfig.tests.json`'s settings against
   `packages/ai` directly — clean.
3. `npm install` (or an equivalent workspace-symlink refresh) so
   `node_modules/@machine-run/ai` exists for real, not just because this
   session manually created the symlink other packages already have to fall
   back on. (An `npm install` did run mid-session for unrelated reasons and
   picked this package up automatically — this is only a concern if a clean
   checkout skips that step.)


## Why `test/**` relaxes `noChainedTypeAssertions`

The MCP backend tests build stand-ins for `AiToolContext`'s `fs`/`path`, which
the CLI-driven backends (Codex, Grok) never call — they shell out instead. A
double assertion is the only way to hand a partial object to a parameter typed
as the full interface, and the alternative — implementing every method of
`FileSystem`/`Path` as `Effect.die` — would be a large amount of code asserting
nothing.

This is scoped to `test/**` in this package alone. The rule stays on for `src/`,
where a chained assertion really does mean a boundary that should be parsed.
