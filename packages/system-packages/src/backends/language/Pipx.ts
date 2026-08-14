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
 * `pipx install "<name>==<version>"` — pip's own `==` pin, verified against
 * `docker run --rm python:3.12`: `pipx install "cowsay==5.0"` installed
 * exactly that version (`pipx list --short` then read `cowsay 5.0`).
 *
 * A real, load-bearing discovery this container surfaced: pipx's plain
 * `install` refuses outright once a package of that *name* exists at all,
 * regardless of which version is requested — `pipx install
 * "cowsay==99.99.99"` (with `5.0` already installed) never even attempted to
 * resolve `99.99.99`; it printed `'cowsay' (5.0) already seems to be
 * installed. Not modifying existing installation ... Pass '--force' to force
 * installation`. So `--force` is not merely a nice-to-have here — without
 * it, `apply` re-pinning an already-installed pipx package to a *different*
 * version would be a silent no-op, exactly the class of bug rule 0b names.
 * `install` below always passes `--force` when a version is pinned, which is
 * harmless when the name is genuinely absent (nothing to force over) and is
 * the only way a version change ever takes effect when it isn't.
 *
 * `canDowngrade: true` — PyPI serves every published release forever (a
 * yank hides it from plain resolution but not from an explicit `==`), and
 * `--force` is exactly what makes a downgrade actually happen rather than be
 * refused; no separate confirmation of the downgrade direction specifically
 * was run, since the refusal above already demonstrated `--force` is what's
 * required regardless of which direction the version change goes.
 */
export const pipxVersionSupport: PackageVersionSupport = {
  accepts: new Set(["Exact"]),
  canDowngrade: true,
};

const rejectSpec = rejectUnsupportedVersionSpec("pipx", pipxVersionSupport);

/**
 * `pipx list --short` prints one `<name> <version>` line per installed
 * package and nothing else — except when nothing is installed, where it
 * prints a friendly one-line banner instead of empty output
 * (`nothing has been installed with pipx 😴`, verified locally with pipx
 * 1.16.6). That banner tokenizes to far more than two words, so requiring
 * exactly two — name and version, `--short`'s documented shape — excludes it
 * without hard-coding the exact wording (which isn't a stable API; see
 * `AGENTS.md` rule 11).
 *
 * Verified locally (macOS, pipx installed via `brew install pipx`):
 * `pipx install cowsay` then `pipx list --short` printed exactly
 * `cowsay 6.1`, and installing needed no extra flags — `pipx install` is
 * non-interactive by default.
 *
 * Independently reverified against `docker run --rm python:3.12`
 * (`python -m pip install pipx`, pipx 1.16.6): the empty-state banner is
 * byte-identical to the local capture above, and after `pipx install cowsay`
 * followed by `pipx install yt-dlp`, `pipx list --short` printed
 * `cowsay 6.1` and `yt-dlp 2026.7.4` on separate lines — the first real
 * multi-package listing this parser has been checked against (fixtures:
 * `test/fixtures/pipx-list{,-empty}.txt`).
 */
export const parsePipxList = (stdout: string): PackageEntry[] => {
  const entries: PackageEntry[] = [];
  for (const line of lines(stdout)) {
    const parts = line.split(/\s+/);
    const name = parts[0];
    const version = parts[1];
    if (parts.length === 2 && name !== undefined && version !== undefined) {
      entries.push({ name, version });
    }
  }
  return entries;
};

/** Declared here rather than inline at each `exec`, the same way this
 * backend's `versions` is: one statement of what this tool's own work costs. */
const pipxTimeouts: PackageTimeouts = {
  install: Timeouts.languagePackage,
  refresh: Timeouts.indexRefresh,
};

export const makePipxBackend = (): PackageManagerBackend => ({
  id: "pipx",
  executable: "pipx",
  shell: "posix",
  versions: pipxVersionSupport,
  timeouts: pipxTimeouts,
  list: (exec) =>
    exec({ command: Sh.sh("pipx", "list", "--short") }).pipe(
      Effect.map((result) => parsePipxList(result.stdout)),
    ),
  install: (name, version, exec) =>
    UndefinedOr.match(version, {
      onUndefined: () =>
        exec({
          command: Sh.sh("pipx", "install", name),
          shell: true,
          timeout: pipxTimeouts.install,
        }).pipe(Effect.asVoid),
      onDefined: (spec) =>
        Match.value(spec).pipe(
          Match.tagsExhaustive({
            // `--force` — see this module's doc comment: without it, pipx
            // refuses to touch an already-installed name at all, regardless
            // of which version was requested.
            Exact: (v) =>
              exec({
                command: Sh.sh("pipx", "install", "--force", `${name}==${v.version}`),
                shell: true,
                timeout: pipxTimeouts.install,
              }).pipe(Effect.asVoid),
            AtLeast: rejectSpec,
            Channel: rejectSpec,
            Digest: rejectSpec,
          }),
        ),
    }),
});
