import type { AiToolBackend } from "../Backend.ts";

/**
 * Tools whose entire known layout is "a `skills/` directory, and maybe a
 * couple of reviewed config files" — no CLI or file format for MCP servers
 * was verified against any of them on the machine this package was written
 * against (see docs/ai-notes.md for what was and wasn't checked, and why).
 * Batched in one module rather than eight near-empty ones, unlike
 * `Claude.ts`/`Codex.ts`/`Grok.ts`/`OpenCode.ts`, which each carry real
 * parsing or CLI-invocation logic that earns its own file.
 *
 * `cursor` and `gemini` are known to be installed on this machine (their
 * `skills/` directories exist under `~/.cursor` and `~/.gemini`), but
 * neither's CLI was present to interrogate, and neither had an existing MCP
 * config file to read the real shape from. Both tools' MCP support is
 * publicly documented as a `mcpServers`-keyed JSON file, but "documented
 * elsewhere" is not "grounded here" — see AGENTS.md rule 5. `copilot`,
 * `agents`, and the four `~/.config/<tool>` families have neither a CLI nor
 * any public MCP documentation this session could verify against, so they
 * are not represented as candidates at all.
 */
export const CursorBackend: AiToolBackend = {
  id: "cursor",
  skillsDir: ".cursor/skills",
  reviewedConfigFiles: [],
};

export const GeminiBackend: AiToolBackend = {
  id: "gemini",
  skillsDir: ".gemini/skills",
  reviewedConfigFiles: [],
};

export const CopilotBackend: AiToolBackend = {
  id: "copilot",
  skillsDir: ".copilot/skills",
  reviewedConfigFiles: [".copilot/config.json"],
};

export const AgentsBackend: AiToolBackend = {
  id: "agents",
  skillsDir: ".agents/skills",
  reviewedConfigFiles: [],
};

export const ConfigAgentsBackend: AiToolBackend = {
  id: "config-agents",
  skillsDir: ".config/agents/skills",
  reviewedConfigFiles: [],
};

export const ConfigCrushBackend: AiToolBackend = {
  id: "config-crush",
  skillsDir: ".config/crush/skills",
  reviewedConfigFiles: [],
};

export const ConfigForgeBackend: AiToolBackend = {
  id: "config-forge",
  skillsDir: ".config/forge/skills",
  reviewedConfigFiles: [".config/forge/config.json"],
};

export const ConfigGooseBackend: AiToolBackend = {
  id: "config-goose",
  skillsDir: ".config/goose/skills",
  reviewedConfigFiles: [],
};
