import * as Dotfiles from "@machine-run/dotfiles";
import * as Effect from "effect/Effect";

export interface GitPersonaProps {
  /** Short slug, e.g. "personal" or "obvious". Used in the managed-block marker and generated filename. */
  persona: string;
  name: string;
  email: string;
  signingKey?: string;
  /** Glob passed to `[includeIf "gitdir:<pathGlob>"]` — repos under this path use this persona. */
  pathGlob: string;
  /** Absolute path to the shared `~/.gitconfig` this persona's includeIf stanza is inserted into. */
  gitconfigPath: string;
  /** Absolute path to this persona's own generated config file, e.g. `~/.gitconfig-personal`. */
  personaConfigPath: string;
  /**
   * If set (with `zshrcPath`), switches the active `gh` CLI account to this
   * login via a zsh `chpwd` hook whenever you `cd` under `pathGlob`. `gh`'s
   * active account is a single global CLI setting, not per-directory, so
   * this is a shell hook rather than a resource of its own.
   */
  ghAccount?: string;
  /** Required when `ghAccount` is set — absolute path to `~/.zshrc`. */
  zshrcPath?: string;
}

const renderPersonaConfig = (props: GitPersonaProps) =>
  [
    "[user]",
    `\tname = ${props.name}`,
    `\temail = ${props.email}`,
    ...(props.signingKey ? [`\tsigningkey = ${props.signingKey}`] : []),
    "",
  ].join("\n");

/** Converts a git `includeIf gitdir:` glob (e.g. ".../flatfiles/**") into a zsh `case` pattern. */
const toShellGlob = (pathGlob: string) => `${pathGlob.replace(/\/\*\*$/, "")}*`;

const renderGhAccountHook = (props: GitPersonaProps & { ghAccount: string }) =>
  [
    `_machine_run_gh_${props.persona}() {`,
    `  case "$PWD" in`,
    `    ${toShellGlob(props.pathGlob)}) gh auth switch --user ${props.ghAccount} >/dev/null 2>&1 ;;`,
    "  esac",
    "}",
    `chpwd_functions+=(_machine_run_gh_${props.persona})`,
  ].join("\n");

/**
 * Composes {@link Dotfiles.File} (the persona's own config), {@link
 * Dotfiles.ManagedBlock} (the `includeIf` stanza in the shared
 * `~/.gitconfig`), and optionally another {@link Dotfiles.ManagedBlock} (the
 * `gh` account chpwd hook in `~/.zshrc`) into one git identity. Not a custom
 * Resource itself — just a reusable composition of the dotfiles primitives.
 */
export const gitIdentity = (props: GitPersonaProps) =>
  Effect.gen(function* () {
    yield* Dotfiles.File(`gitconfig-${props.persona}`, {
      path: props.personaConfigPath,
      content: renderPersonaConfig(props),
    });

    yield* Dotfiles.ManagedBlock(`gitconfig-include-${props.persona}`, {
      path: props.gitconfigPath,
      marker: `git-identity:${props.persona}`,
      content: [
        `[includeIf "gitdir:${props.pathGlob}"]`,
        `\tpath = ${props.personaConfigPath}`,
      ].join("\n"),
    });

    if (props.ghAccount && props.zshrcPath) {
      const ghAccount = props.ghAccount;
      yield* Dotfiles.ManagedBlock(`gh-account-${props.persona}`, {
        path: props.zshrcPath,
        marker: `gh-account:${props.persona}`,
        content: renderGhAccountHook({ ...props, ghAccount }),
      });
    }
  });
