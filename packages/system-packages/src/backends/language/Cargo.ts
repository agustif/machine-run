import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import type { PackageManagerBackend } from "../../Backend.ts";
import { firstTokens } from "../../parse.ts";

/**
 * Verified against `docker run --rm rust:latest`: `cargo install --list`
 * printed nothing on a fresh image (confirming the empty case doesn't need
 * special-casing), then `cargo install just --locked` followed by
 * `cargo install ripgrep --locked` produced exactly
 * ```
 * just v1.58.0:
 *     just
 * ripgrep v15.2.0:
 *     rg
 * ```
 * — two unindented `<crate> v<version>:` headers, each followed by one
 * indented binary line, matching the format this parser has always assumed
 * (fixture: `test/fixtures/cargo-install-list.txt`). No parser change was
 * needed.
 */
export const makeCargoBackend = (): PackageManagerBackend => ({
  id: "cargo",
  list: (exec) =>
    exec({ command: Sh.sh("cargo", "install", "--list") }).pipe(
      Effect.map((result) =>
        firstTokens(
          result.stdout
            .split("\n")
            // `cargo install --list` prints "name vX.Y.Z:" per crate, then
            // indented lines for that crate's installed binaries. Only the
            // unindented lines are crate names — so this filter must run on
            // the *raw* lines, before any trimming.
            .filter((line) => line.length > 0 && !line.startsWith(" ")),
        ),
      ),
    ),
  install: (name, exec) =>
    exec({
      command: Sh.sh("cargo", "install", name),
      shell: true,
      timeout: "10 minutes",
    }).pipe(Effect.asVoid),
});
