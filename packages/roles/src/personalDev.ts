import * as Dotfiles from "@machine-run/dotfiles";
import { gitIdentity } from "@machine-run/git-identity";
import * as Effect from "effect/Effect";

export interface PersonalDevProps {
  /** Absolute path to the user's home directory, e.g. "/Users/a". */
  home: string;
  /**
   * Personal git commit email. Defaults to GitHub's privacy-preserving
   * no-reply address for the `agustif` account — override if you'd rather
   * use a real personal address.
   */
  email?: string;
}

/** Personal-identity + personal-machine baseline config, independent of any work role. */
export const personalDev = (props: PersonalDevProps) =>
  Effect.gen(function* () {
    yield* gitIdentity({
      persona: "personal",
      name: "agustí",
      email: props.email ?? "agustif@users.noreply.github.com",
      pathGlob: `${props.home}/**`,
      gitconfigPath: `${props.home}/.gitconfig`,
      personaConfigPath: `${props.home}/.gitconfig-personal`,
    });

    yield* Dotfiles.File("mise-config", {
      path: `${props.home}/.config/mise/config.toml`,
      content: ['[tools]', 'node = "26"', ""].join("\n"),
    });
  });
