import { Sh, Timeouts } from "@machine-run/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  BackendParseError,
  type RuntimeBackend,
  type RuntimeObservation,
  type RuntimeScope,
  type UvToolIdentity,
  type RuntimeTimeouts,
} from "../Backend.ts";

/**
 * `uv python list --only-installed --output-format json` prints one entry
 * per discovered interpreter — including several rows for the *same*
 * version when more than one path resolves to it (a `python3.11` binary and
 * a `python3` symlink pointing at it both appear). Real, captured output
 * (`uv 0.12.2`, this machine):
 *
 * ```json
 * [
 *   {"key":"cpython-3.11.15-macos-aarch64-none","version":"3.11.15", ...
 *    "path":"/Users/a/.local/bin/python3.11", "symlink": "..." },
 *   {"key":"cpython-3.11.15-macos-aarch64-none","version":"3.11.15", ...
 *    "path":"/Users/a/.local/share/uv/python/.../python3.11", "symlink": null }
 * ]
 * ```
 *
 * so `observe` de-duplicates by `version`.
 *
 * Unlike mise/asdf, this listing carries no "active" flag at all — uv's
 * pin resolution (project `.python-version`, then a global one) is a
 * property of *where* `uv run`/`uvx` is invoked, not of the installed set.
 * There is also no query subcommand that answers "what's pinned at path P"
 * directly (`uv python find` resolves to an interpreter *path*, not a
 * version, and reverse-mapping that path back through the listing above is
 * strictly more roundabout than reading the pin file `uv python pin`
 * itself writes). So `observe` reads that file directly with `FileSystem`,
 * the same way `Machine.File`/`Machine.ManagedBlock` read the files they
 * own rather than shelling out to `cat` — verified directly: `uv python pin
 * --global 3.12` writes the literal text `3.12` (the request, not a
 * resolved patch version) to `~/.config/uv/.python-version`, and a project
 * pin behaves identically at `<dir>/.python-version`.
 */
const UvPythonEntry = Schema.Struct({ version: Schema.String });
const UvPythonList = Schema.fromJsonString(Schema.Array(UvPythonEntry));
const decodeUvPythonList = Schema.decodeUnknownEffect(UvPythonList);

const uvTimeouts: RuntimeTimeouts = { install: Timeouts.systemPackage };

export const makeUvBackend = (deps: {
  home: string;
  path: Path.Path;
  fs: FileSystem.FileSystem;
  /**
   * uv resolves its own config directory as `$XDG_CONFIG_HOME/uv` — verified
   * directly by pinning with a substitute `$HOME` and finding the file at
   * `<home>/.config/uv/.python-version` with no `XDG_CONFIG_HOME` set (i.e.
   * the default fallback of `$HOME/.config`), matching the same convention
   * `uv python dir`'s data-directory answer uses. Not verified with
   * `XDG_CONFIG_HOME` actually set to something else; honoring it here is a
   * reasonable extension of the verified default, not a guess about a flag.
   * Resolved once by `Tool.ts` via `effect/Config` — see `Mise.ts`'s doc
   * comment for why.
   */
  configDirOverride: string | undefined;
}): RuntimeBackend<UvToolIdentity> => {
  const { home, path, fs, configDirOverride } = deps;

  const configDir = configDirOverride ?? path.join(home, ".config");
  const globalPinPath = path.join(configDir, "uv", ".python-version");

  const configPath = (scope: RuntimeScope): string =>
    scope._tag === "Global" ? globalPinPath : path.join(scope.path, ".python-version");

  const readPin = (target: string) =>
    fs.readFileString(target).pipe(
      Effect.map((content) => {
        const trimmed = content.trim();
        return trimmed.length > 0 ? trimmed : undefined;
      }),
      Effect.catch((error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );

  const observe: RuntimeBackend<UvToolIdentity>["observe"] = (_identity, scope, exec) =>
    Effect.gen(function* () {
      const result = yield* exec({
        command: Sh.sh("uv", "python", "list", "--only-installed", "--output-format", "json"),
      });
      const entries = yield* decodeUvPythonList(result.stdout).pipe(
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(new BackendParseError({ manager: "uv", cause })),
        ),
      );
      const installed = [...new Set(entries.map((entry) => entry.version))];
      const active = yield* readPin(configPath(scope));
      return { installed, active } satisfies RuntimeObservation;
    });

  const install: RuntimeBackend<UvToolIdentity>["install"] = ({ version }, exec) =>
    exec({
      command: Sh.sh("uv", "python", "install", version),
      shell: true,
      timeout: uvTimeouts.install,
    }).pipe(Effect.asVoid);

  const activate: RuntimeBackend<UvToolIdentity>["activate"] = ({ version }, scope, exec) =>
    scope._tag === "Global"
      ? exec({
          command: Sh.sh("uv", "python", "pin", "--global", version),
          shell: true,
          timeout: uvTimeouts.install,
        }).pipe(Effect.asVoid)
      : exec({
          command: Sh.sh("uv", "python", "pin", version),
          shell: true,
          cwd: scope.path,
          timeout: uvTimeouts.install,
        }).pipe(Effect.asVoid);

  return {
    id: "Uv",
    timeouts: uvTimeouts,
    // uv only ever manages Python — there is no second tool to name, and
    // `UvToolIdentity` (`Backend.ts`) has no `tool` field for a caller to
    // misname in the first place.
    configPath,
    observe,
    install,
    activate,
  };
};
