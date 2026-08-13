import type { ShellBackend } from "../Backend.ts";
import {
  renderPosixAlias,
  renderPosixCase,
  renderPosixEnvVar,
  renderPosixPathEntry,
  toPosixIdent,
} from "./posix.ts";

/**
 * zsh reads `~/.zshrc` for every *interactive* shell, login or not — unlike
 * bash, there is no separate file a login invocation reads instead (see
 * `Bash.ts` for why that shell needs one). So `rcPath` alone is enough here;
 * no `loginRc`.
 *
 * The directory-change hook uses zsh's first-class `chpwd_functions` array,
 * called automatically after every `cd`. Verified in a container (zsh 5.9,
 * Ubuntu 24.04 — see `docs/shell-notes.md`): a function appended to
 * `chpwd_functions` fired exactly once per `cd`, with no dedupe guard
 * needed — unlike bash's `PROMPT_COMMAND`, this hook is never invoked except
 * on an actual directory change.
 */
export const ZshBackend: ShellBackend = {
  id: "zsh",
  commentPrefix: "#",
  rcPath: "~/.zshrc",
  renderEnvVar: renderPosixEnvVar,
  renderPathEntry: renderPosixPathEntry,
  renderAlias: renderPosixAlias,
  renderHook: (props) => {
    const fnName = `_machine_run_${toPosixIdent(props.name)}`;
    return [
      `${fnName}() {`,
      ...renderPosixCase(props.pathGlob, props.command)
        .split("\n")
        .map((line) => `  ${line}`),
      "}",
      `chpwd_functions+=(${fnName})`,
    ].join("\n");
  },
};
