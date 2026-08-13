import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { BackendParseError, type RuntimeBackend, type RuntimeScope } from "../Backend.ts";

/**
 * `mise ls <tool> --json` prints an array — one entry per installed version
 * of `tool` — each carrying `installed` and `active` together. Real,
 * captured output (`mise 2026.7.18`, this machine):
 *
 * ```json
 * [
 *   {
 *     "version": "20.20.2",
 *     "requested_version": "20.20.2",
 *     "install_path": "/Users/a/.local/share/mise/installs/node/20.20.2",
 *     "source": { "type": "mise.toml", "path": "/Users/a/proj/mise.toml" },
 *     "installed": true,
 *     "active": true
 *   }
 * ]
 * ```
 *
 * `active` is resolved with respect to the *current working directory* of
 * the `mise` process — verified directly: the same tool, listed from inside a
 * project with its own `mise.toml` versus from a directory with none, reports
 * a different entry as active. That is why {@link makeMiseBackend}'s
 * `observe` always passes an explicit `cwd`, rather than trusting whatever
 * directory the machine-run process itself happens to be running in.
 *
 * `requested_version`/`install_path`/`source` are real fields but unused here
 * — `Runtime.Tool` only needs the resolved version and the two booleans, and
 * a narrower schema is one fewer thing that can start rejecting real output
 * if mise adds fields later (`Schema.Struct` ignores unknown keys by default).
 */
const MiseListEntry = Schema.Struct({
  version: Schema.String,
  installed: Schema.Boolean,
  active: Schema.Boolean,
});

const MiseList = Schema.fromJsonString(Schema.Array(MiseListEntry));
const decodeMiseList = Schema.decodeUnknownEffect(MiseList);

const parseFailure = (cause: unknown) => new BackendParseError({ manager: "mise", cause });

/**
 * mise's own `--json` listing already answers both halves of an
 * {@link RuntimeObservation} in one shell-out, so `observe` here is exactly
 * one command per call — no separate "which one is active" round trip.
 */
export const makeMiseBackend = (deps: {
  home: string;
  path: Path.Path;
  /**
   * `MISE_GLOBAL_CONFIG_FILE` is the one override mise's own `--help`
   * documents for relocating the global config away from the default
   * `~/.config/mise/config.toml` — verified via `mise use --help`. Resolved
   * once, effectfully, by the caller (`Tool.ts`, via `effect/Config`) rather
   * than read here with a bare `process.env`: `Reconciler.address` must be
   * synchronous, so the env lookup happens once at backend-construction time
   * and this factory just closes over the already-resolved value.
   */
  globalConfigOverride: string | undefined;
}): RuntimeBackend => {
  const { home, path, globalConfigOverride } = deps;

  const globalConfigPath =
    globalConfigOverride ?? path.join(home, ".config", "mise", "config.toml");

  const configPath = (scope: RuntimeScope): string =>
    scope._tag === "Global" ? globalConfigPath : path.join(scope.path, "mise.toml");

  const observe: RuntimeBackend["observe"] = (tool, scope, exec) =>
    Effect.gen(function* () {
      const cwd = scope._tag === "Global" ? home : scope.path;
      const result = yield* exec({
        command: Sh.sh("mise", "ls", tool, "--json"),
        shell: true,
        cwd,
      });
      const entries = yield* decodeMiseList(result.stdout).pipe(
        Effect.catchTag("SchemaError", (cause) => Effect.fail(parseFailure(cause))),
      );
      const active = entries.find((entry) => entry.active);
      return {
        installed: entries.filter((entry) => entry.installed).map((entry) => entry.version),
        active: active?.version,
      };
    });

  const install: RuntimeBackend["install"] = (tool, version, exec) =>
    exec({
      command: Sh.sh("mise", "install", `${tool}@${version}`),
      shell: true,
      timeout: "15 minutes",
    }).pipe(Effect.asVoid);

  const activate: RuntimeBackend["activate"] = (tool, version, scope, exec) => {
    const spec = `${tool}@${version}`;
    // `--pin` records the exact resolved version in the config file rather
    // than the fuzzy request, so a later `observe` reads back a concrete
    // string — matching every other backend, which only ever report
    // concrete versions too. `-y` skips mise's interactive prompts, which
    // would otherwise hang under Alchemy's non-interactive stdin.
    return scope._tag === "Global"
      ? exec({
          command: Sh.sh("mise", "use", "--global", "--pin", "-y", spec),
          shell: true,
          timeout: "15 minutes",
        }).pipe(Effect.asVoid)
      : exec({
          command: Sh.sh("mise", "use", "--pin", "-y", spec),
          shell: true,
          cwd: scope.path,
          timeout: "15 minutes",
        }).pipe(Effect.asVoid);
  };

  return { id: "mise", configPath, observe, install, activate };
};
