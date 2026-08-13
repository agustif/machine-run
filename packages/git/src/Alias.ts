import * as Effect from "effect/Effect";
import { Config } from "./Config.ts";

export interface GitAliasProps {
  /** The alias name, e.g. `"co"` for `git co` — becomes the `alias.<name>` key. */
  readonly name: string;
  /** The command it expands to, e.g. `"checkout"` or `"!gh pr create"`. */
  readonly command: string;
}

/**
 * A single `git <name>` alias, via the `alias.<name>` config key.
 *
 * A thin composition over {@link Config} rather than a `Reconciler`: an
 * alias *is* one config value, with no file and no multi-valued semantics —
 * there is nothing here `Config` doesn't already model.
 */
export const gitAlias = (id: string, props: GitAliasProps) =>
  Effect.gen(function* () {
    return yield* Config(id, {
      key: `alias.${props.name}`,
      values: [props.command],
    });
  });
