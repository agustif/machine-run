import * as Dotfiles from "@machine-run/dotfiles";
import * as Effect from "effect/Effect";
import { Config } from "./Config.ts";

/**
 * Shared shape behind {@link gitIgnore} and {@link gitAttributes}: a global
 * `git config` key that names a file, plus the file itself. Extracted here
 * because both compositions are otherwise identical — only the key and the
 * file's content differ — and the alternative was writing the same two-
 * resource wiring twice.
 */
export interface GitConfigFileProps {
  /** The `git config` key that should point at `path` — `core.excludesFile` or `core.attributesFile`. */
  readonly configKey: string;
  /** Where the file should live. `~` is expanded by {@link Dotfiles.File}. */
  readonly path: string;
  /** The file's full desired content. */
  readonly content: string;
}

/**
 * Composes a {@link Dotfiles.File} (the file's content) with a {@link Config}
 * (the global key pointing at it) — not a `Reconciler` itself, since neither
 * piece needs a new state schema: `Dotfiles.File` already owns "a file with
 * this content exists", and `Config` already owns "this global key holds
 * this value". Passing `path` as an already-`MachinePaths`-expanded string
 * (done by the caller composing this, not here) means the config value is a
 * plain absolute path, sidestepping `--type=path`'s read-time `~`-expansion
 * hazard documented on {@link Config}.
 */
export const gitConfigFile = (id: string, props: GitConfigFileProps) =>
  Effect.gen(function* () {
    const file = yield* Dotfiles.File(`${id}-file`, {
      path: props.path,
      content: props.content,
    });
    const config = yield* Config(`${id}-config`, {
      key: props.configKey,
      values: [props.path],
    });
    return { file, config };
  });
