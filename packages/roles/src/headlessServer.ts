import { gitIdentity } from "@machine-run/git-identity";
import * as Effect from "effect/Effect";

export interface HeadlessServerProps {
  home: string;
  email: string;
  pathGlob: string;
}

/**
 * A lighter role for Linux servers: just the work git identity, no Homebrew
 * (server package management is left to the OS's own package manager for
 * now — see the sequencing notes in the plan for why this stays minimal).
 */
export const headlessServer = (props: HeadlessServerProps) =>
  Effect.gen(function* () {
    yield* gitIdentity({
      persona: "obvious",
      name: "agustí",
      email: props.email,
      pathGlob: props.pathGlob,
      gitconfigPath: `${props.home}/.gitconfig`,
      personaConfigPath: `${props.home}/.gitconfig-obvious`,
    });
  });
