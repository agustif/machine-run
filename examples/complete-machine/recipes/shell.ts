import * as Shell from "@machine-run/shell";
import * as Effect from "effect/Effect";

/**
 * `Shell.Login`, plus the rc-file compositions.
 *
 * Every composition here renders for one specific shell's syntax — `export
 * FOO=bar` in zsh is `set -gx FOO bar` in fish and `$env.FOO = "bar"` in nu —
 * so `shell` is a required prop rather than something inferred from the login
 * shell. A machine commonly configures more than one.
 */
export const shell = Effect.gen(function* () {
  // The login shell itself, via `chsh`. An absolute path, not a `ShellId`:
  // fish, nu and pwsh have no fixed install location to infer, since Homebrew,
  // apt, cargo and a manual build each land somewhere different.
  yield* Shell.Login("login-shell", {
    shell: "/bin/zsh",
  });

  yield* Shell.envVar("editor", {
    shell: "zsh",
    name: "EDITOR",
    value: "nvim",
  });

  yield* Shell.pathEntry("local-bin", {
    shell: "zsh",
    dir: "$HOME/.local/bin",
  });

  yield* Shell.alias("alias-ll", {
    shell: "zsh",
    name: "ll",
    command: "ls -lah",
  });

  // A directory-change hook. Each shell has its own mechanism —
  // `chpwd_functions` in zsh, `PROMPT_COMMAND` in bash, `--on-variable PWD` in
  // fish, `hooks.env_change` in nu — which the backend renders.
  yield* Shell.hook("hook-node-version", {
    shell: "zsh",
    name: "use_node_version",
    pathGlob: "$HOME/code/*",
    command: "mise install",
  });

  // A login shell reads its login file, not its rc file, so an interactive
  // config placed only in `.zshrc` never loads in a login shell. This writes
  // the sourcing line that bridges them.
  yield* Shell.ensureLoginShellLoadsRc("zsh-login-loads-rc", {
    shell: "zsh",
  });

  // A second shell, to show that these are per-shell rather than global. The
  // same `EDITOR` is rendered in fish's own syntax, into fish's own config.
  yield* Shell.envVar("editor-fish", {
    shell: "fish",
    name: "EDITOR",
    value: "nvim",
  });
});
