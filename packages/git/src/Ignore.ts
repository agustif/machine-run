import * as Effect from "effect/Effect";
import { gitConfigFile } from "./ConfigFile.ts";

export interface GitIgnoreProps {
  /** Where the global ignore file should live, e.g. `~/.gitignore_global`. `~` is expanded. */
  readonly path: string;
  /** Gitignore patterns, one per line, in the order they should appear. */
  readonly patterns: readonly string[];
}

/**
 * A machine-wide `.gitignore`, wired in via `core.excludesFile` (verified
 * real key, `man git-config`'s "core.excludesFile" — every repository
 * consults it in addition to its own `.gitignore`).
 *
 * A composition over {@link Config} and `Dotfiles.File`, not a `Reconciler`:
 * "a file with this content, referenced by this config key" is exactly what
 * {@link gitConfigFile} already is, and gitignore's own format (patterns,
 * one per line, `#` comments, `!` negation) needs no parsing here — the
 * whole file is generated, so it is `Machine.File`'s job, not
 * `Machine.ManagedBlock`'s.
 */
export const gitIgnore = (id: string, props: GitIgnoreProps) =>
  Effect.gen(function* () {
    return yield* gitConfigFile(id, {
      configKey: "core.excludesFile",
      path: props.path,
      content: props.patterns.length > 0 ? `${props.patterns.join("\n")}\n` : "",
    });
  });
