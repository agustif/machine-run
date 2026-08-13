import * as Ai from "@machine-run/ai";
import * as Effect from "effect/Effect";

/**
 * `@machine-run/ai-tools` is being phased out in favour of `@machine-run/ai`,
 * which replaced its two frozen arrays and a `for` loop with a real backend
 * seam (`AiToolBackend`, one module per tool, dispatched by id — see
 * `packages/ai/src/Backend.ts`) and added `Ai.McpServer`, which this package
 * never had at all. This module is kept only so nothing importing
 * `@machine-run/ai-tools` today breaks; it should be deleted before 1.0 —
 * see docs/ai-notes.md. New code should depend on `@machine-run/ai` directly.
 */
export interface AiToolsProps {
  /** The user's home directory, e.g. "/Users/a" or "~". `~` is accepted — see `@machine-run/ai`'s `Ai.Skill`. */
  home: string;
  /** This repo's vault directory, e.g. "/Users/a/machine-run/vault/ai". `~` is accepted — see `home`. */
  vaultDir: string;
}

const ALL_TOOL_IDS = Object.keys(Ai.aiToolBackends) as ReadonlyArray<Ai.AiToolId>;

/** Every tool id's `skills/` directory, derived from `@machine-run/ai`'s registry rather than duplicated here. */
export const AI_TOOL_SKILLS_DIRS = ALL_TOOL_IDS.map((id) => ({
  id,
  real: Ai.aiToolBackends[id].skillsDir,
}));

/**
 * Every tool id's reviewed config files, flattened to one entry per file.
 * `id` is derived (`<tool>` when a tool has exactly one reviewed file,
 * `<tool>-<n>` when it has more, e.g. Codex's `config.toml` and
 * `AGENTS.md`) rather than reproduced from the original hand-picked ids
 * (`codex-config`, `codex-agents-md`, ...) — nothing in this repo reads
 * those ids, so there is nothing to keep byte-identical, and generating them
 * means this list can never drift from `AiToolBackend.reviewedConfigFiles`.
 */
export const AI_TOOL_CONFIG_FILES = ALL_TOOL_IDS.flatMap((id) => {
  const files = Ai.aiToolBackends[id].reviewedConfigFiles;
  return files.map((real, index) => ({
    id: files.length === 1 ? id : `${id}-${index}`,
    real,
  }));
});

export const aiToolSkills = (props: AiToolsProps) =>
  Ai.aiSkills({ home: props.home, vaultDir: props.vaultDir, tools: ALL_TOOL_IDS });

export const aiToolConfigFiles = (props: AiToolsProps) =>
  Ai.aiConfigs({ home: props.home, vaultDir: props.vaultDir, tools: ALL_TOOL_IDS });

export const aiTools = (props: AiToolsProps) =>
  Effect.gen(function* () {
    yield* aiToolSkills(props);
    yield* aiToolConfigFiles(props);
  });
