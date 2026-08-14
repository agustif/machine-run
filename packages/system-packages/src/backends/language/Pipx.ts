import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import type { PackageManagerBackend } from "../../Backend.ts";
import { lines } from "../../parse.ts";

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
export const parsePipxList = (stdout: string): string[] => {
  const names: string[] = [];
  for (const line of lines(stdout)) {
    const parts = line.split(/\s+/);
    if (parts.length === 2 && parts[0] !== undefined) names.push(parts[0]);
  }
  return names;
};

export const makePipxBackend = (): PackageManagerBackend => ({
  id: "pipx",
  list: (exec) =>
    exec({ command: Sh.sh("pipx", "list", "--short") }).pipe(
      Effect.map((result) => parsePipxList(result.stdout)),
    ),
  install: (name, exec) =>
    exec({
      command: Sh.sh("pipx", "install", name),
      shell: true,
      timeout: "5 minutes",
    }).pipe(Effect.asVoid),
});
