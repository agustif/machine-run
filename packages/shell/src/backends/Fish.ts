import type { ShellBackend } from "../Backend.ts";
import { quoteFish } from "../quote.ts";

const toIdent = (name: string) => name.replace(/[^a-zA-Z0-9_]/g, "_");

/**
 * fish reads `~/.config/fish/config.fish` for every session, login or not —
 * like zsh, and unlike bash, so `rcPath` alone is enough here.
 *
 * `pathEntry` deliberately does **not** use fish's own `fish_add_path`
 * helper. Verified in a container (fish 3.7.0): by default it writes to the
 * `fish_user_paths` *universal* variable rather than `PATH` directly, and a
 * universal variable persists independently of `config.fish` — set once, it
 * stays set even after every managed block that ever called `fish_add_path`
 * is removed, which is exactly the kind of drift a `Dotfiles.ManagedBlock`
 * diff can never see (it only hashes its own region's text). Using
 * `contains`/`set` directly keeps `PATH` entirely a function of what's
 * between this region's markers, with no state fish itself remembers
 * elsewhere.
 */
export const FishBackend: ShellBackend = {
  id: "fish",
  commentPrefix: "#",
  rcPath: "~/.config/fish/config.fish",

  renderEnvVar: (name, value) => `set -gx ${name} ${quoteFish(value)}`,

  /**
   * `contains -- dir $PATH` is fish's native list-membership test — `PATH` is
   * a real list in fish, not a colon-joined string, so there is no
   * delimiter-collision hazard the POSIX `case ":$PATH:" in *":$dir:"*)` idiom
   * guards against. Verified in a container: adding the same directory twice
   * left `$PATH` with exactly one occurrence.
   */
  renderPathEntry: (dir) =>
    [
      `if not contains -- ${quoteFish(dir)} $PATH`,
      `    set -gx PATH ${quoteFish(dir)} $PATH`,
      "end",
    ].join("\n"),

  /**
   * fish's `alias` is sugar for defining a function (confirmed in a
   * container: `alias ll "ls -la"` produces `function ll --wraps='ls -la' ...;
   * ls -la $argv; end`), and — unlike a plain `alias` typed interactively —
   * it is **not** persisted on its own. Writing it into `config.fish` is what
   * makes it durable: fish re-runs the `alias` line, and so redefines the
   * function, every time a new session sources the file.
   */
  renderAlias: (name, command) => `alias ${name} ${quoteFish(command)}`,

  /**
   * `function ... --on-variable PWD` fires whenever fish's `PWD` variable is
   * set, which includes every `cd`. Verified live in a container (fish
   * 3.7.0): three `cd`s produced three hook firings, one per change.
   */
  renderHook: (props) => {
    const fnName = `_machine_run_${toIdent(props.name)}`;
    return [
      `function ${fnName} --on-variable PWD`,
      `    switch $PWD`,
      `        case ${quoteFish(props.pathGlob)}`,
      `            ${props.command}`,
      "    end",
      "end",
    ].join("\n");
  },
};
