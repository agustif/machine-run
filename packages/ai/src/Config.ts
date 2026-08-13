import * as Dotfiles from "@machine-run/dotfiles";
import * as Effect from "effect/Effect";
import type { AiToolId } from "./Backend.ts";
import { aiToolBackend } from "./Store.ts";

export interface AiConfigProps {
  /** See {@link import("./Skill.ts").AiSkillProps.home}. */
  home: string;
  /** This repo's vault directory, e.g. `~/machine-run/vault/ai`. */
  vaultDir: string;
  tool: AiToolId;
}

/** Logical-id-safe rendering of a relative path — Alchemy ids must be stable strings, not arbitrary paths. */
const sanitize = (relativePath: string): string => relativePath.replace(/[^a-zA-Z0-9._-]/g, "-");

/**
 * `AiToolBackend.skillsDir` and every `reviewedConfigFiles` entry share one
 * directory (e.g. `.codex/skills` and `.codex/config.toml` both live under
 * `.codex`) — this strips that shared prefix so the vault only nests once,
 * under `config/<tool>/`, rather than repeating the tool's own dotfile
 * directory name inside a path that is already namespaced by tool.
 */
const relativeToToolDir = (skillsDir: string, relativePath: string): string => {
  const toolDir = skillsDir.replace(/\/skills$/, "");
  return relativePath.startsWith(`${toolDir}/`)
    ? relativePath.slice(toolDir.length + 1)
    : relativePath;
};

/**
 * Every one of `tool`'s individually-reviewed config files, each symlinked
 * from `vaultDir/config/<tool>/<file>` — one {@link Dotfiles.Symlink} per
 * file, read from `AiToolBackend.reviewedConfigFiles`. A tool with none
 * declared (most of the twelve — see `backends/Basic.ts`) yields no
 * resources at all: nothing here invents a config file to track just because
 * a tool exists.
 *
 * Same posture as {@link import("./Skill.ts").aiSkill}: `Dotfiles.Symlink`
 * refuses to create a symlink unless the vault already holds the reviewed
 * file, so nothing is copied into version control automatically.
 */
export const aiConfig = (props: AiConfigProps) =>
  Effect.gen(function* () {
    const backend = aiToolBackend(props.tool);
    for (const relativePath of backend.reviewedConfigFiles) {
      const vaultRelative = relativeToToolDir(backend.skillsDir, relativePath);
      yield* Dotfiles.Symlink(`ai-config-${props.tool}-${sanitize(vaultRelative)}`, {
        path: `${props.home}/${relativePath}`,
        source: `${props.vaultDir}/config/${props.tool}/${vaultRelative}`,
      });
    }
  });

/** Sugar over one {@link aiConfig} per tool — see {@link import("./Skill.ts").aiSkills}'s doc comment. */
export const aiConfigs = (props: {
  home: string;
  vaultDir: string;
  tools: readonly AiToolId[];
}) =>
  Effect.gen(function* () {
    for (const tool of props.tools) {
      yield* aiConfig({ home: props.home, vaultDir: props.vaultDir, tool });
    }
  });
