import { Sh } from "@machine-run/core";

/**
 * Rendering shared by bash and zsh: both are POSIX `sh`-family shells with
 * identical `export`/`alias`/`case` syntax. Only the directory-change hook's
 * *outer* wiring differs (zsh's `chpwd_functions` array vs bash's
 * `PROMPT_COMMAND`, the latter also needing a dedupe guard — see
 * `Bash.ts` and `Zsh.ts`), so this module holds everything both shells
 * render identically, and each backend module writes its own `renderHook`.
 */

/** Identifier-safe form of a name, for a generated function name. */
export const toPosixIdent = (name: string): string => name.replace(/[^a-zA-Z0-9_]/g, "_");

/** `export NAME=value`, with `value` quoted via `Sh.quote` so it survives sourcing verbatim. */
export const renderPosixEnvVar = (name: string, value: string): string =>
  `export ${name}=${Sh.quote(value)}`;

/** Escapes a value for placement inside a POSIX double-quoted string (`"..."`). */
const escapeDoubleQuoted = (value: string): string => value.replace(/[\\$`"]/g, "\\$&");

/**
 * Prepends `dir` to `PATH`, guarded so re-sourcing the rc file (a new
 * terminal tab, `source ~/.zshrc`) never grows `PATH` without bound.
 *
 * The `case ":$PATH:" in *":$dir:"*)` idiom (the same one Homebrew's and
 * nvm's own shell integration use) checks membership by wrapping both sides
 * in `:` delimiters, so a directory that is merely a *substring* of another
 * `PATH` entry — `/usr/local/bin` inside `/usr/local/bin2` — does not read as
 * already present.
 */
export const renderPosixPathEntry = (dir: string): string => {
  const escaped = escapeDoubleQuoted(dir);
  return [
    `case ":$PATH:" in`,
    `  *":${escaped}:"*) ;;`,
    `  *) export PATH="${escaped}:$PATH" ;;`,
    "esac",
  ].join("\n");
};

/** `alias name=command`, with `command` quoted via `Sh.quote`. */
export const renderPosixAlias = (name: string, command: string): string =>
  `alias ${name}=${Sh.quote(command)}`;

/**
 * The `case "$PWD" in ...` glob dispatch shared by every POSIX hook body.
 *
 * `pathGlob` is inserted unescaped: it is meant to be interpreted as a shell
 * glob pattern (`*`, `?`, `[...]`), not a literal string, so escaping it here
 * would defeat the caller's intent.
 */
export const renderPosixCase = (pathGlob: string, command: string): string =>
  [`case "$PWD" in`, `  ${pathGlob}) ${command} ;;`, "esac"].join("\n");
