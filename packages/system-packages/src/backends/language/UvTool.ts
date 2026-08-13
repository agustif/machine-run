import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import type { PackageManagerBackend } from "../../Backend.ts";
import { firstTokens, lines } from "../../parse.ts";

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
 */
export const parseUvToolList = (stdout: string): string[] =>
  firstTokens(lines(stdout).filter((line) => /^\S+\s+v\d/.test(line)));

export const makeUvToolBackend = (): PackageManagerBackend => ({
  id: "uv-tool",
  list: (exec) =>
    exec({ command: "uv tool list" }).pipe(Effect.map((result) => parseUvToolList(result.stdout))),
  install: (name, exec) =>
    exec({
      command: Sh.sh("uv", "tool", "install", name),
      shell: true,
      timeout: "5 minutes",
    }).pipe(Effect.asVoid),
});
