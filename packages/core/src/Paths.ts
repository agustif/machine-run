import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { homedir } from "node:os";

/**
 * Expands a leading `~` and returns an absolute, normalised path.
 *
 * Pure and total so it can be unit-tested without a filesystem. Only a
 * leading `~/` (or a bare `~`) is expanded — `~other/x` is another user's
 * home in shell convention, which we deliberately do **not** guess at, and
 * a `~` anywhere but the front is an ordinary filename character.
 */
export const expandHome = (path: Path.Path, target: string, home: string): string => {
  const expanded =
    target === "~"
      ? home
      : target.startsWith("~/") || target.startsWith("~\\")
        ? path.join(home, target.slice(2))
        : target;
  return path.resolve(expanded);
};

/**
 * Resolves the paths a recipe writes.
 *
 * ## Why this is a service and not just `process.env.HOME`
 *
 * Every path prop in machine-run is documented as "absolute", which in
 * practice meant every recipe hard-coded someone's literal home directory —
 * `examples/example-machine` says `/home/you` and then sets macOS defaults,
 * a combination that is wrong on every real machine. A recipe should be able
 * to say `~/.zshrc` and be portable across machines and users.
 *
 * It also fixes a subtler correctness problem. `Machine.Symlink`'s diff
 * compares the live `readLink` target against `news.source` as raw strings,
 * so `/Users/a/vault/` and `/Users/a/vault` (or `~/vault`) compare unequal
 * forever: every plan reports a change, every deploy rewrites the link, and
 * the resource never converges. Normalising both sides through one service
 * makes "same path" mean the same thing everywhere.
 */
export class MachinePaths extends Context.Service<
  MachinePaths,
  {
    /** This machine's home directory, already absolute. */
    readonly home: string;
    /** Expands `~`, then normalises to an absolute path. */
    readonly expand: (target: string) => string;
  }
>()("machine-run/MachinePaths") {}

export const MachinePathsLive = () =>
  Layer.effect(
    MachinePaths,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      // `os.homedir()` rather than `$HOME`: it falls back to the passwd
      // entry when the env var is unset (cron, launchd, a bare `sudo`),
      // which is exactly the situation where a machine reconciler runs.
      const home = path.resolve(homedir());
      return {
        home,
        expand: (target: string) => expandHome(path, target, home),
      };
    }),
  );

/**
 * Whether a platform failure means "there is nothing at this path".
 *
 * Effect 4's `PlatformError` carries a structured `reason` — a `BadArgument`
 * or a `SystemError` whose `_tag` is a normalised `SystemErrorTag` — so this
 * is a typed field read rather than a match on a message.
 */
export const isNotFound = (error: PlatformError): boolean => error.reason._tag === "NotFound";
