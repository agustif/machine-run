import { Sh, Timeouts } from "@machine-run/core";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as UndefinedOr from "effect/UndefinedOr";
import {
  type PackageEntry,
  type PackageManagerBackend,
  type PackageVersionSupport,
  rejectUnsupportedVersionSpec,
  type PackageTimeouts,
} from "../../Backend.ts";
import { lines } from "../../parse.ts";

/**
 * `uv tool install "<name>==<version>"` — pip-style pin, verified against
 * `docker run --rm python:3.12` (`pip install uv`): `uv tool install
 * "cowsay==5.0"` printed `Resolved 1 package in 1.81s` / `Installed 1
 * package in 3.46s` / `+ cowsay==5.0`, confirming the syntax resolves and
 * installs the pinned version, and `uv tool install "cowsay==99.99.99"`
 * failed with a real dependency-resolution error: `No solution found when
 * resolving dependencies: Because there is no version of cowsay==99.99.99
 * and you require cowsay==99.99.99, we can conclude that your requirements
 * are unsatisfiable.`
 *
 * One real, incidental finding from the same run, worth recording rather
 * than silently working around: the `cowsay==5.0` install above also printed
 * `error: Executable already exists: cowsay (use --force to overwrite)` —
 * because `pipx` (installed and exercised in the same container, same
 * `$HOME`, for `Pipx.ts`'s own verification) had already linked a `cowsay`
 * shim into the same `~/.local/bin`. uv resolved and installed the package
 * into its own tool store regardless (confirmed by `+ cowsay==5.0` above),
 * it only failed to link the shim — a cross-tool `$HOME` collision specific
 * to running both managers in one container back to back, not a limitation
 * of `uv tool install` itself. It did mean `uv tool list` read back "No
 * tools installed" immediately after, so this session could not
 * independently confirm `uv tool list`'s pinned-version line shape beyond
 * what `UvTool.ts`'s existing doc comment already established.
 *
 * That collision left one real question genuinely open rather than settled:
 * whether `uv tool install` also refuses to *re-pin an already-uv-installed*
 * tool to a different version without `--force`, the same way `Pipx.ts`
 * confirmed pipx's own `install` does (a bare re-`install` there silently
 * no-ops, exit 0, when anything is already installed under that name,
 * regardless of whether the requested version matches). This session's own
 * run cannot distinguish "uv refuses to overwrite its own prior version"
 * from "uv refuses to overwrite pipx's shim" — the failure happened before
 * uv had ever successfully installed `cowsay` itself. Passing `--force`
 * unconditionally on every `Exact` pin, below, is the defensive reading:
 * cheap when unneeded (a fresh install has nothing to force past) and
 * necessary if uv's own re-pin behaviour turns out to match pipx's.
 */
export const uvToolVersionSupport: PackageVersionSupport = {
  accepts: new Set(["Exact"]),
  canDowngrade: true,
};

const rejectSpec = rejectUnsupportedVersionSpec("uv-tool", uvToolVersionSupport);

/**
 * `uv tool list` prints one `<name> v<version>` header line per installed
 * tool, followed by one `- <executable>` line per entry point it exposes —
 * structurally like `Cargo.ts`'s `cargo install --list`, but *without*
 * indentation on the sub-lines (verified: `- cowsay`, not `  - cowsay`), so
 * the sub-lines can't be told apart from headers by leading whitespace the
 * way Cargo's can. Requiring the second whitespace-token to start with `v`
 * followed by a digit does: every header is `<name> v<semver>` and no
 * sub-line's second token takes that shape. It also excludes the one-line
 * "No tools installed" banner `uv tool list` prints on an empty install (its
 * second token is `tools`).
 *
 * Verified locally (macOS, `uv` 0.12.2, already installed on this machine):
 * empty state printed exactly `No tools installed`; `uv tool install cowsay`
 * then `uv tool list` printed:
 * ```
 * cowsay v6.1
 * - cowsay
 * ```
 *
 * Independently reverified against `docker run --rm python:3.12`
 * (`python -m pip install uv`, uv 0.12.4): the empty-state message is
 * byte-identical, and after `uv tool install cowsay` followed by
 * `uv tool install yt-dlp`, `uv tool list` printed two full header+sub-line
 * pairs back to back —
 * ```
 * cowsay v6.1
 * - cowsay
 * yt-dlp v2026.7.4
 * - yt-dlp
 * ```
 * — the first real multi-tool listing this parser has been checked against,
 * confirming the `v\d` header regex doesn't false-match a second tool's own
 * sub-line (fixtures: `test/fixtures/uv-tool-list{,-empty}.txt`).
 */
export const parseUvToolList = (stdout: string): PackageEntry[] => {
  const entries: PackageEntry[] = [];
  for (const line of lines(stdout)) {
    const match = /^(\S+)\s+v(\d\S*)/.exec(line);
    if (match === null) continue;
    const name = match[1];
    const version = match[2];
    if (name === undefined) continue;
    entries.push(version === undefined ? { name } : { name, version });
  }
  return entries;
};

/** Declared here rather than inline at each `exec`, the same way this
 * backend's `versions` is: one statement of what this tool's own work costs. */
const uvToolTimeouts: PackageTimeouts = {
  install: Timeouts.languagePackage,
  refresh: Timeouts.indexRefresh,
};

export const makeUvToolBackend = (): PackageManagerBackend => ({
  id: "uv-tool",
  executable: "uv",
  shell: "posix",
  versions: uvToolVersionSupport,
  timeouts: uvToolTimeouts,
  list: (exec) =>
    exec({ command: Sh.sh("uv", "tool", "list") }).pipe(
      Effect.map((result) => parseUvToolList(result.stdout)),
    ),
  install: (name, version, exec) =>
    UndefinedOr.match(version, {
      onUndefined: () =>
        exec({
          command: Sh.sh("uv", "tool", "install", name),
          shell: true,
          timeout: uvToolTimeouts.install,
        }).pipe(Effect.asVoid),
      onDefined: (spec) =>
        Match.value(spec).pipe(
          Match.tagsExhaustive({
            Exact: (v) =>
              exec({
                command: Sh.sh("uv", "tool", "install", "--force", `${name}==${v.version}`),
                shell: true,
                timeout: uvToolTimeouts.install,
              }).pipe(Effect.asVoid),
            AtLeast: rejectSpec,
            Channel: rejectSpec,
            Digest: rejectSpec,
          }),
        ),
    }),
});
