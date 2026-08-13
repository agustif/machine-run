import * as Dotfiles from "@machine-run/dotfiles";
import * as Effect from "effect/Effect";
import type { AiToolId } from "./Backend.ts";
import { aiToolBackend } from "./Store.ts";

export interface AiSkillProps {
  /**
   * The user's home directory, e.g. `/Users/a` or `~`. `~` is accepted here:
   * both this and `vaultDir` are only ever string-concatenated into
   * {@link Dotfiles.Symlink}'s `path`/`source` props, and that resource
   * expands `~` itself via `MachinePaths` before touching the filesystem.
   */
  home: string;
  /** This repo's vault directory, e.g. `~/machine-run/vault/ai`. */
  vaultDir: string;
  tool: AiToolId;
}

/**
 * One AI tool's `skills/` directory, made available by symlinking it to a
 * reviewed location under `vaultDir/skills/<tool>` — composed over
 * {@link Dotfiles.Symlink} the way `packages/ssh/src/Host.ts`'s `sshHost`
 * composes over `Dotfiles.ManagedBlock`.
 *
 * Never a blanket symlink of the tool's whole config directory: `~/.claude`,
 * `~/.codex` and the rest also hold `auth.json`, session tokens, and sqlite
 * databases that must never be checked into a git repo. `Dotfiles.Symlink`
 * itself is what enforces this can't happen by accident — it refuses to
 * create a symlink unless `source` already exists, so a `skills/` directory
 * only ever enters version control because a human copied and reviewed it
 * there first, never automatically.
 */
export const aiSkill = (props: AiSkillProps) => {
  const backend = aiToolBackend(props.tool);
  return Dotfiles.Symlink(`ai-skill-${props.tool}`, {
    path: `${props.home}/${backend.skillsDir}`,
    source: `${props.vaultDir}/skills/${props.tool}`,
  });
};

/**
 * Sugar over one {@link aiSkill} per tool — not a bundle resource. Each tool
 * still becomes its own atomic, independently-diffed `Machine.Symlink`; this
 * only saves writing the loop at every call site, the same way
 * `system-packages/src/bulk.ts`'s `packages` does for `System.Package`.
 */
export const aiSkills = (props: {
  home: string;
  vaultDir: string;
  tools: readonly AiToolId[];
}) =>
  Effect.gen(function* () {
    for (const tool of props.tools) {
      yield* aiSkill({ home: props.home, vaultDir: props.vaultDir, tool });
    }
  });
