import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import type { PackageManagerBackend } from "../../Backend.ts";
import { firstTokens } from "../../parse.ts";

export const makeCargoBackend = (): PackageManagerBackend => ({
  id: "cargo",
  list: (exec) =>
    exec({ command: "cargo install --list" }).pipe(
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
