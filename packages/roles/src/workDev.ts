import { gitIdentity } from "@machine-run/git-identity";
import * as Effect from "effect/Effect";

export interface WorkDevProps {
  /** Absolute path to the user's home directory, e.g. "/Users/a". */
  home: string;
  /** Work email for this identity, e.g. "agusti@obvious.ai" or "agusti@flatfile.io". */
  email: string;
  /** Glob covering the work directories that should use this identity, e.g. "/Users/a/code/flatfiles/**". */
  pathGlob: string;
  /** `gh` CLI account to switch to under `pathGlob` (e.g. "agustiobvious"). Omit to leave `gh`'s account untouched. */
  ghAccount?: string;
}

/** Obvious/Flatfile work identity, scoped to work directories via `pathGlob`. */
export const workDev = (props: WorkDevProps) =>
  Effect.gen(function* () {
    yield* gitIdentity({
      persona: "obvious",
      name: "agustí",
      email: props.email,
      pathGlob: props.pathGlob,
      gitconfigPath: `${props.home}/.gitconfig`,
      personaConfigPath: `${props.home}/.gitconfig-obvious`,
      ghAccount: props.ghAccount,
      zshrcPath: `${props.home}/.zshrc`,
    });
  });
