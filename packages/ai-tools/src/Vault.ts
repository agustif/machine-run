import * as Dotfiles from "@machine-run/dotfiles";
import * as Effect from "effect/Effect";

/**
 * Almost every AI coding CLI on this machine (Claude, Codex, Cursor, Gemini,
 * Grok, Copilot, plus the `agents`/`crush`/`forge`/`goose`/`opencode`
 * families under `~/.config`) keeps a `skills/` directory and one or two
 * plain settings files — and also a pile of session/auth/cache state that
 * must NEVER be checked into a git repo.
 *
 * This package deliberately only symlinks the reviewed-safe subset via
 * {@link Dotfiles.Symlink}, which refuses to do anything unless a matching
 * file already exists under `vaultDir` — i.e. content only ever enters
 * version control because a human copied and reviewed it first, never
 * automatically. It never touches: `auth.json`, anything named
 * `*session*`/`*token*`/`*credential*`, `*.db`/`*.sqlite*`, `logs`, `cache`,
 * `*.lock`, or `history.jsonl` — those stay local-only, by design.
 */
export interface AiToolsProps {
  /** Absolute path to the user's home directory, e.g. "/Users/a". */
  home: string;
  /** Absolute path to this repo's vault directory, e.g. "/Users/a/machine-run/vault/ai-tools". */
  vaultDir: string;
}

/** Tools whose `skills/` directory is safe to track — no credentials live alongside it. */
export const AI_TOOL_SKILLS_DIRS = [
  { id: "claude", real: ".claude/skills" },
  { id: "codex", real: ".codex/skills" },
  { id: "cursor", real: ".cursor/skills" },
  { id: "gemini", real: ".gemini/skills" },
  { id: "grok", real: ".grok/skills" },
  { id: "copilot", real: ".copilot/skills" },
  { id: "agents", real: ".agents/skills" },
  { id: "config-agents", real: ".config/agents/skills" },
  { id: "config-crush", real: ".config/crush/skills" },
  { id: "config-forge", real: ".config/forge/skills" },
  { id: "config-goose", real: ".config/goose/skills" },
  { id: "config-opencode", real: ".config/opencode/skills" },
] as const;

/** Individually-reviewed plain settings/config files — never `auth.*`, `*session*`, or DB/cache files. */
export const AI_TOOL_CONFIG_FILES = [
  { id: "claude-settings", real: ".claude/settings.json" },
  { id: "codex-config", real: ".codex/config.toml" },
  { id: "codex-agents-md", real: ".codex/AGENTS.md" },
  { id: "grok-config", real: ".grok/config.toml" },
  { id: "copilot-config", real: ".copilot/config.json" },
  { id: "forge-config", real: ".config/forge/config.json" },
] as const;

/**
 * Each tool keeps its own `skills/` directory separate under the vault
 * (`<vaultDir>/skills/<id>`) rather than assuming they're interchangeable
 * across tools — consolidate manually later if you actually want one shared
 * skills library across all of them.
 */
export const aiToolSkills = (props: AiToolsProps) =>
  Effect.gen(function* () {
    for (const { id, real } of AI_TOOL_SKILLS_DIRS) {
      yield* Dotfiles.Symlink(`ai-tools-skills-${id}`, {
        path: `${props.home}/${real}`,
        source: `${props.vaultDir}/skills/${id}`,
      });
    }
  });

export const aiToolConfigFiles = (props: AiToolsProps) =>
  Effect.gen(function* () {
    for (const { id, real } of AI_TOOL_CONFIG_FILES) {
      yield* Dotfiles.Symlink(`ai-tools-config-${id}`, {
        path: `${props.home}/${real}`,
        source: `${props.vaultDir}/config/${id}`,
      });
    }
  });

export const aiTools = (props: AiToolsProps) =>
  Effect.gen(function* () {
    yield* aiToolSkills(props);
    yield* aiToolConfigFiles(props);
  });
