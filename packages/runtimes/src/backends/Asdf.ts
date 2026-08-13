import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import type { RuntimeBackend, RuntimeObservation, RuntimeScope } from "../Backend.ts";
import { lines } from "../parse.ts";

/**
 * asdf (v0.20.0, verified in a Linux container — see `docs/runtime-notes.md`)
 * requires a tool's plugin to be added before anything else works: `asdf list
 * <tool>` and `asdf current <tool>` both fail outright ("No such plugin: X",
 * exit 1) against a tool nothing has touched yet.
 *
 * `observe` must stay read-only — it runs during planning, and `asdf plugin
 * add` clones a git repository, which is a real side effect. So `observe`
 * checks membership with `asdf plugin list` first (real output, real Linux
 * container: `nodejs`, exit 0; or `No plugins installed`, also exit 0, when
 * none exist) and only asks `asdf list <tool>` about a plugin already
 * present. Adding a missing plugin is `install`'s job, which only ever runs
 * from `apply`.
 *
 * `asdf list <tool>` marks the version active *at the process's cwd* with a
 * leading `*` — verified directly: the same tool, listed from inside a
 * directory with its own `.tool-versions` versus one without, marks a
 * different entry. Real captured output, one version installed and active:
 *
 * ```
 *  *22.11.0
 * ```
 *
 * and zero installed:
 *
 * ```
 * No compatible versions installed (nodejs)
 * ```
 *
 * That message is filtered out by requiring a candidate to be a single,
 * whitespace-free token — the same shape every real version string has, and
 * the one thing a multi-word status line never is.
 *
 * `asdf current <tool>` was tried first and rejected: it exits non-zero
 * (verified: `126` when nothing is set, `1` when the pinned version isn't
 * installed) even though the informative row is printed to stdout, not
 * stderr — and Alchemy's `CommandExecutor` discards stdout once a command's
 * exit code is non-zero, keeping only `stderr` on the resulting
 * `CommandError`. `list`'s `*` marker gives the identical information without
 * ever going through a failing exit code.
 */
export const makeAsdfBackend = (deps: {
  home: string;
  path: Path.Path;
  /**
   * `ASDF_TOOL_VERSIONS_FILENAME` is a real, documented asdf variable —
   * verified via `asdf info`'s "ASDF INTERNAL VARIABLES" section, which
   * reports it as `.tool-versions` by default. Resolved once by `Tool.ts` via
   * `effect/Config` — see `Mise.ts`'s doc comment for why. No variable
   * relocates *where* the global file lives (unlike mise's
   * `MISE_GLOBAL_CONFIG_FILE`) — asdf always resolves it against `$HOME`, so
   * `home` is used directly for that part.
   */
  filenameOverride: string | undefined;
}): RuntimeBackend => {
  const { home, path, filenameOverride } = deps;

  const filename = filenameOverride ?? ".tool-versions";

  const configPath = (scope: RuntimeScope): string =>
    scope._tag === "Global" ? path.join(home, filename) : path.join(scope.path, filename);

  const observe: RuntimeBackend["observe"] = (tool, scope, exec) =>
    Effect.gen(function* () {
      const cwd = scope._tag === "Global" ? home : scope.path;

      const plugins = yield* exec({ command: "asdf plugin list", cwd });
      if (!lines(plugins.stdout).includes(tool)) {
        return { installed: [], active: undefined } satisfies RuntimeObservation;
      }

      const result = yield* exec({ command: Sh.sh("asdf", "list", tool), shell: true, cwd });
      const candidates = lines(result.stdout).filter((line) => /^\*?\S+$/.test(line));
      return {
        installed: candidates.map((line) => line.replace(/^\*/, "")),
        active: candidates.find((line) => line.startsWith("*"))?.replace(/^\*/, ""),
      } satisfies RuntimeObservation;
    });

  const install: RuntimeBackend["install"] = (tool, version, exec) =>
    Effect.gen(function* () {
      // Idempotent — verified: exit 0 both the first time and every time
      // after ("Plugin named nodejs already added", still exit 0).
      yield* exec({ command: Sh.sh("asdf", "plugin", "add", tool), shell: true });
      yield* exec({
        command: Sh.sh("asdf", "install", tool, version),
        shell: true,
        timeout: "15 minutes",
      });
    }).pipe(Effect.asVoid);

  const activate: RuntimeBackend["activate"] = (tool, version, scope, exec) =>
    // `-u`/`--home` targets `$HOME`'s file regardless of cwd; its absence
    // writes into (or creates) cwd's own file — verified directly, including
    // that a fresh directory with no `.tool-versions` gets one created
    // exactly there, not at the nearest ancestor's.
    scope._tag === "Global"
      ? exec({ command: Sh.sh("asdf", "set", "-u", tool, version), shell: true }).pipe(
          Effect.asVoid,
        )
      : exec({
          command: Sh.sh("asdf", "set", tool, version),
          shell: true,
          cwd: scope.path,
        }).pipe(Effect.asVoid);

  return { id: "asdf", configPath, observe, install, activate };
};
