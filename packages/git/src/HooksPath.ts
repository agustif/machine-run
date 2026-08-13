import * as Dotfiles from "@machine-run/dotfiles";
import * as Effect from "effect/Effect";
import { Config } from "./Config.ts";

export interface GitHooksPathProps {
  /** Directory that should hold the managed hooks. `~` is expanded. */
  readonly path: string;
  /** Hook script content, keyed by hook filename (`"pre-commit"`, `"commit-msg"`, ...). */
  readonly hooks: Readonly<Record<string, string>>;
}

/**
 * A shared hooks directory, wired in via `core.hooksPath` (verified real
 * key, `man git-config`: "By default Git will look for your hooks in the
 * `$GIT_DIR/hooks` directory. Set this to [a] different path... and Git will
 * try to find your hooks [there] instead").
 *
 * A composition over {@link Config}, `Dotfiles.Directory` and one
 * `Dotfiles.File` per hook — not a `Reconciler`: none of "a directory
 * exists", "a file with this content exists" or "this config key holds this
 * value" is new state to model, only new wiring between three pieces that
 * already exist.
 *
 * Every hook file is written with mode `0o755`. Verified by actually
 * running a commit against a real `core.hooksPath`: a non-executable
 * `pre-commit` is silently skipped — git prints an advisory hint ("hook was
 * ignored because it's not set as executable") and proceeds as if the hook
 * did not exist at all, rather than failing — while the identical script
 * with the executable bit set runs and can block the commit. Leaving mode
 * unset here (as `Dotfiles.File`'s own default does) would mean a hook that
 * silently never runs.
 */
export const gitHooksPath = (id: string, props: GitHooksPathProps) =>
  Effect.gen(function* () {
    const directory = yield* Dotfiles.Directory(`${id}-dir`, {
      path: props.path,
      mode: 0o755,
    });

    const config = yield* Config(`${id}-config`, {
      key: "core.hooksPath",
      values: [props.path],
    });

    const base = props.path.replace(/\/$/, "");
    const hooks: Record<string, Dotfiles.File> = {};
    for (const [name, content] of Object.entries(props.hooks)) {
      hooks[name] = yield* Dotfiles.File(`${id}-hook-${name}`, {
        path: `${base}/${name}`,
        content,
        mode: 0o755,
      });
    }

    return { directory, config, hooks };
  });
