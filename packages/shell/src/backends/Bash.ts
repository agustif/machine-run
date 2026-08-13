import type { ShellBackend } from "../Backend.ts";
import {
  renderPosixAlias,
  renderPosixCase,
  renderPosixEnvVar,
  renderPosixPathEntry,
  toPosixIdent,
} from "./posix.ts";

/**
 * ## Why bash needs a second rc file
 *
 * Verified in a container (Ubuntu 24.04's `/etc/skel` — see `docs/shell-
 * notes.md`): bash's own default `~/.bashrc` opens with
 * `case $- in *i*) ;; *) return;; esac` — it refuses to do anything unless
 * the shell is already interactive. Every non-login interactive invocation
 * (a Linux terminal emulator's default shell, a `tmux`/`screen` pane, typing
 * `bash` inside another shell) reads exactly this file, and only this file.
 *
 * A *login* invocation — macOS Terminal.app's default for a bash user,
 * `ssh host` where the remote's login shell is bash — does **not** read
 * `.bashrc` at all unless something sources it. bash's own login lookup is
 * `~/.bash_profile`, then `~/.bash_login`, then `~/.profile` — first one that
 * exists, and *only* that one. Debian/Ubuntu's default `~/.profile` happens
 * to source `~/.bashrc` (confirmed by reading `/etc/skel/.profile`), but only
 * because `~/.bash_profile` doesn't exist yet on a fresh account. If this
 * backend wrote real content straight into a *new* `~/.bash_profile`, the
 * very next login shell would read only that file and skip `~/.profile`
 * entirely — silently dropping whatever `~/.profile` used to do (Ubuntu's
 * default adds `~/bin` and `~/.local/bin` to `PATH`). macOS ships no
 * `~/.profile` by default at all, so a bash user there gets nothing from
 * `.bashrc` on login unless something bridges the two files.
 *
 * ## The fix, and why it isn't automatic
 *
 * `rcPath` (`~/.bashrc`) is where `envVar`/`pathEntry`/`alias`/`hook` write
 * their content — verified live in a container that its `PROMPT_COMMAND`
 * hook fires correctly for a non-login interactive shell (see `renderHook`
 * below). `loginRc` describes one extra, deliberately tiny managed block for
 * `~/.bash_profile` that sources `~/.profile` (preserving whatever it did)
 * and then `~/.bashrc` (picking up everything managed here) — never the
 * caller's actual content duplicated into a second file, which would risk
 * double-registering the `PROMPT_COMMAND` hook for a user whose existing
 * `~/.bash_profile` already sources `~/.bashrc` by hand.
 *
 * None of `envVar`/`pathEntry`/`alias`/`hook` writes `loginRc` on their own —
 * see `ShellBackend.loginRc`'s doc comment for why silently taking over a
 * second rc file on every call would be worse than not helping at all.
 * `Shell.ensureLoginShellLoadsRc` is the explicit, opt-in composition
 * function a caller uses once per recipe if they need bash login shells
 * (macOS Terminal.app, `ssh` running bash as the login shell) to see this
 * content too.
 */
export const BashBackend: ShellBackend = {
  id: "bash",
  commentPrefix: "#",
  rcPath: "~/.bashrc",
  renderEnvVar: renderPosixEnvVar,
  renderPathEntry: renderPosixPathEntry,
  renderAlias: renderPosixAlias,

  /**
   * bash has no `chpwd`-style hook, so the closest equivalent is prepending
   * to `PROMPT_COMMAND` (run before every prompt) and comparing `$PWD`
   * against the last value seen, so the glob dispatch only fires on an
   * actual change rather than on every single prompt redraw.
   *
   * Verified live in a container (bash's own `--rcfile`, run as an
   * interactive shell via `bash --rcfile <this> -i`, feeding three `cd`s over
   * stdin — see `docs/shell-notes.md`): the hook fired exactly once per
   * distinct directory, not once per prompt.
   */
  renderHook: (props) => {
    const fnName = `_machine_run_${toPosixIdent(props.name)}`;
    return [
      `${fnName}_prev_pwd=""`,
      `${fnName}() {`,
      `  if [ "$PWD" != "$${fnName}_prev_pwd" ]; then`,
      `    ${fnName}_prev_pwd="$PWD"`,
      ...renderPosixCase(props.pathGlob, props.command)
        .split("\n")
        .map((line) => `    ${line}`),
      "  fi",
      "}",
      // Prepend rather than overwrite, so an rc file that already sets
      // PROMPT_COMMAND keeps running its own command too.
      `PROMPT_COMMAND="${fnName}\${PROMPT_COMMAND:+; $PROMPT_COMMAND}"`,
    ].join("\n");
  },

  loginRc: {
    path: "~/.bash_profile",
    render: () =>
      [
        `if [ -f "$HOME/.profile" ]; then . "$HOME/.profile"; fi`,
        `if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi`,
      ].join("\n"),
  },
};
