import { CommandExecutor } from "alchemy/Command";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";

export interface MacDefaultProps {
  /** `defaults` domain, e.g. "com.apple.dock" or "NSGlobalDomain". */
  domain: string;
  key: string;
  type: "bool" | "int" | "float" | "string";
  /** Always the string form `defaults write` expects, e.g. "true", "35". */
  value: string;
  /** App to `killall` after a real write so the change takes visible effect, e.g. "Dock", "Finder". */
  restartApp?: string;
}

/**
 * One `defaults write <domain> <key> -<type> <value>` setting. Always writes
 * explicitly rather than only-if-different-from-factory-default: the point
 * is a value that's reproducible on any machine, not just "whatever this Mac
 * happened to have."
 *
 * diff compares against this resource's own last-recorded output rather than
 * re-reading `defaults read` live — a deliberate, cheap optimization (like
 * alchemy's own `Command.Exec` memoization) since nothing but machine-run is
 * expected to touch these keys once managed.
 */
export interface MacDefault
  extends Resource<
    "MacOS.Default",
    MacDefaultProps,
    { domain: string; key: string; value: string }
  > {}

export const MacDefault = Resource<MacDefault>("MacOS.Default");

export const MacDefaultProvider = () =>
  Provider.effect(
    MacDefault,
    Effect.gen(function* () {
      const executor = yield* CommandExecutor;

      return MacDefault.Provider.of({
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
          if (!output || output.value !== news.value) {
            return { action: "update" as const };
          }
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          yield* executor.run(
            {
              command: `defaults write ${news.domain} ${news.key} -${news.type} ${news.value}`,
              shell: true,
            },
            session,
          );
          if (news.restartApp) {
            // `killall` exits non-zero if the app isn't running — not an error.
            yield* executor
              .run({ command: `killall ${news.restartApp}`, shell: true }, session)
              .pipe(Effect.catchTag("CommandError", () => Effect.void));
          }
          return { domain: news.domain, key: news.key, value: news.value };
        }),
        // Never reverts a system preference on `alchemy destroy`.
        delete: () => Effect.void,
      });
    }),
  );
