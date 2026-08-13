import * as Effect from "effect/Effect";
import { gitConfigFile } from "./ConfigFile.ts";

export interface GitAttributesProps {
  /** Where the global attributes file should live, e.g. `~/.gitattributes_global`. `~` is expanded. */
  readonly path: string;
  /** Gitattributes lines (`pattern attr1 attr2 ...`), in order. */
  readonly lines: readonly string[];
}

/**
 * A machine-wide `.gitattributes`, wired in via `core.attributesFile`
 * (verified real key, `man git-config`'s "core.attributesFile": consulted by
 * every repository in addition to its own `.gitattributes` and
 * `.git/info/attributes`).
 *
 * A composition over {@link Config} and `Dotfiles.File` for the same reason
 * as {@link gitIgnore}: the whole file is generated, so `Machine.File` owns
 * it, and the config key is one value pointing at one path.
 */
export const gitAttributes = (id: string, props: GitAttributesProps) =>
  Effect.gen(function* () {
    return yield* gitConfigFile(id, {
      configKey: "core.attributesFile",
      path: props.path,
      content: props.lines.length > 0 ? `${props.lines.join("\n")}\n` : "",
    });
  });
