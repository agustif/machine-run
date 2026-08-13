import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import { BackendParseError, type RuntimeBackend, type RuntimeObservation } from "../Backend.ts";

/**
 * `rustup show` in one call gives everything {@link RuntimeObservation}
 * needs: the host triple every installed toolchain name is suffixed with,
 * the full installed list (each entry optionally annotated `(active)` /
 * `(default)` / `(active, default)`), and an unambiguous `active toolchain`
 * section naming exactly one toolchain — real, captured output (`rustup
 * 1.29.0`, this machine, with a directory override in place):
 *
 * ```
 * Default host: aarch64-apple-darwin
 * rustup home:  /Users/a/.rustup
 *
 * installed toolchains
 * --------------------
 * stable-aarch64-apple-darwin
 * nightly-aarch64-apple-darwin (active)
 * 1.97.1-aarch64-apple-darwin (default)
 *
 * active toolchain
 * ----------------
 * name: nightly-aarch64-apple-darwin
 * active because: directory override for '/path/to/proj'
 * installed targets:
 *   aarch64-apple-darwin
 * ```
 *
 * `active` is resolved with respect to the process's cwd, exactly like mise —
 * verified directly by running this both inside and outside a directory
 * carrying a `rustup override`. That is why {@link makeRustupBackend}'s
 * `observe` always sets an explicit `cwd`.
 *
 * The `active toolchain` section is absent when nothing is active at all
 * (no default ever set, no override in scope). That case was not produced by
 * any run captured here — this machine has always had a default toolchain —
 * so it is handled (regex simply fails to match, `active` comes back
 * `undefined`) but not verified. Noted in `docs/runtime-notes.md`.
 */
const parseRustupShow = (
  stdout: string,
): { installed: ReadonlyArray<string>; active: string | undefined } | undefined => {
  const hostMatch = /^Default host:\s*(\S+)/m.exec(stdout);
  if (!hostMatch?.[1]) return undefined;
  const host = hostMatch[1];

  // Toolchain names are always `<channel-or-version>-<host triple>` for the
  // default host. Stripping that known suffix is what lets a plain recipe
  // request ("1.97.1", "stable") compare against what rustup actually lists,
  // without machine-run guessing at target-triple syntax itself. A toolchain
  // installed for a *different* host (a cross toolchain) keeps its full,
  // triple-qualified name, since only the default host's suffix is stripped
  // — an intentional, narrower scope: cross toolchains are out of scope for
  // this backend, and a recipe wanting one has to spell it out in full.
  const bareName = (name: string) =>
    name.endsWith(`-${host}`) ? name.slice(0, -(host.length + 1)) : name;

  const installedSection = /installed toolchains\n-+\n([\s\S]*?)\n\n/.exec(stdout);
  const installed = installedSection?.[1]
    ? installedSection[1]
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => bareName(line.split(/\s+/)[0] ?? ""))
    : [];

  const activeMatch = /^name:\s*(\S+)/m.exec(stdout);
  const active = activeMatch?.[1] ? bareName(activeMatch[1]) : undefined;

  return { installed, active };
};

export const makeRustupBackend = (deps: {
  home: string;
  path: Path.Path;
  /**
   * `RUSTUP_HOME` is rustup's own documented relocation variable — verified
   * directly (`RUSTUP_HOME=<dir> rustup show` reports that dir back as
   * "rustup home"). Resolved once by `Tool.ts` via `effect/Config`; see
   * `Mise.ts`'s doc comment for why the resolution happens there and not
   * here, with a bare `process.env`, given `Reconciler.address` must stay
   * synchronous.
   */
  rustupHomeOverride: string | undefined;
}): RuntimeBackend => {
  const { home, path, rustupHomeOverride } = deps;

  const rustupHome = rustupHomeOverride ?? path.join(home, ".rustup");
  // Both `default_toolchain` (the global choice) and every directory
  // `[overrides]` entry live in this ONE file — verified by setting a
  // directory override and reading `~/.rustup/settings.toml` directly.
  // Unlike mise/asdf, where only the *global* scope hits a shared file and
  // each directory gets its own, every rustup scope funnels into this same
  // path — so `configPath` ignores `scope` entirely and every `Runtime.Tool`
  // targeting rustup, at any scope, serialises on the same address.
  const settingsPath = path.join(rustupHome, "settings.toml");

  const observe: RuntimeBackend["observe"] = (_tool, scope, exec) =>
    Effect.gen(function* () {
      const cwd = scope._tag === "Global" ? home : scope.path;
      const result = yield* exec({ command: "rustup show", cwd });
      const parsed = parseRustupShow(result.stdout);
      if (parsed === undefined) {
        return yield* Effect.fail(
          new BackendParseError({
            manager: "rustup",
            cause: 'no "Default host:" line in `rustup show`',
          }),
        );
      }
      return parsed satisfies RuntimeObservation;
    });

  const install: RuntimeBackend["install"] = (_tool, version, exec) =>
    // No `--profile` flag: rustup applies whatever profile this machine is
    // already configured with (`minimal`/`default`/`complete`, set once via
    // `rustup-init` or `rustup set profile`) rather than machine-run
    // inventing an opinion about which components a recipe wants.
    exec({
      command: Sh.sh("rustup", "toolchain", "install", version),
      shell: true,
      timeout: "15 minutes",
    }).pipe(Effect.asVoid);

  const activate: RuntimeBackend["activate"] = (_tool, version, scope, exec) =>
    scope._tag === "Global"
      ? exec({
          command: Sh.sh("rustup", "default", version),
          shell: true,
          timeout: "15 minutes",
        }).pipe(Effect.asVoid)
      : exec({
          command: Sh.sh("rustup", "override", "set", version),
          shell: true,
          cwd: scope.path,
          timeout: "15 minutes",
        }).pipe(Effect.asVoid);

  return {
    id: "rustup",
    // rustup has no "tool" dimension — it manages exactly one thing, the
    // Rust toolchain. `Tool.ts` checks every prop's `tool` against this and
    // fails loudly on a mismatch, rather than silently ignoring whatever a
    // recipe passed.
    fixedTool: "rust",
    configPath: () => settingsPath,
    observe,
    install,
    activate,
  };
};
