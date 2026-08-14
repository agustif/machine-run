# `@machine-run/ai` — backlog

`Ai.McpServer` plus the `aiSkill`/`aiConfig` symlink compositions, over an
`AiToolBackend` seam with 12 ids.

## Verification

**Not one of the 12 backends has been run against its real tool.** Every one
needs the CLI installed and usually logged in, which neither this machine nor CI
has. That makes this the second-least-verified seam in the repo after `secrets`.

- [ ] **Confirm each tool's MCP config path and JSON shape** against the real
      tool, not its docs. The shapes genuinely differ — a `mcpServers` object
      keyed by name, versus an array, versus a TOML table — and a wrong shape
      writes a file the tool silently ignores, which is indistinguishable from
      success. Priority order by likelihood of being wrong: `config-crush`,
      `config-forge`, `config-goose`, `config-agents` (all four inferred from
      documentation only), then `grok`, `copilot`, `gemini`.
- [ ] **`claude mcp list` as the observation path.** Currently `observe` reads
      the config file. Reading the file proves what was written; asking the tool
      proves what it _accepted_. Where a tool has such a command, it is the more
      honest observation.
- [ ] **Verify `aiSkill`'s symlink target survives a tool update.** Several of
      these CLIs rewrite their own config directory on upgrade; a symlink
      replaced by a real directory is drift this would detect but never explain.

## Coverage

- [ ] **`Ai.Skill` and `Ai.Config` are compositions, not resources.** They
      return a `Machine.Symlink`, so they cannot express "this skill directory
      should contain exactly these skills" — an extra skill dropped in by hand is
      invisible. Decide whether that is acceptable (it is the same
      reviewed-allowlist posture the design intends) or whether a real resource
      is needed.
- [ ] **Per-project scope.** All 12 backends address user-global config only.
      Most of these tools also read a project-local config, which is where a
      per-repo MCP server or skill set belongs.
- [ ] **Secret references in `env`.** `McpEnvValue` admits a secret reference,
      but nothing verifies the referenced secret is actually resolvable before
      writing a config that will fail at tool startup. Cross-check against
      `@machine-run/secrets` at `desired` time.

## Design debt

- [ ] **The `config-*` id prefix is a smell.** `config-opencode` and `opencode`
      would be two ids for one tool, distinguished by whether the backend
      handles config or MCP. That is a seam boundary leaking into the id space;
      an `AiToolBackend` should describe one tool and declare which capabilities
      it has.
- [x] **`McpServerProps`/`McpServerState` modelled the transport as two
      independently-`optionalKey` halves.** `command`/`args`/`env` and
      `url`/`headers` sat side by side, so `{}` (neither) and
      `{ command, url }` (both) each type-checked despite the doc comments
      calling them mutually exclusive. Fixed: `transport` is now a
      `Schema.TaggedUnion` (`Stdio` | `Remote`), the same pattern
      `runtimes/src/Backend.ts`'s `RuntimeScope` uses, dispatched with
      `Match.tag`/`Match.exhaustive` in `McpServer.ts`. `env` only exists on
      `Stdio`, `headers` only on `Remote`. This is a props-and-state schema
      break — nothing here has ever been deployed, so nothing needed
      migrating. `McpServerState`'s secret-never-in-state property (`envKeys`/
      `envLiteral`/`headerKeys`/`headerLiteral`, never a resolved secret
      value) is unchanged; only the surrounding shape moved.
- [x] **`McpEnvValue`'s secret half moved to `@machine-run/secrets`' new
      `SecretSource` tagged union**, replacing the old
      `{ source: SecretBackendId, ref: string }` pair, in step with that
      package's own typing pass (see `secrets/TASKS.md`).
