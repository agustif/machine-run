import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import type { PackageManagerBackend } from "../../Backend.ts";
import { firstTokens, lines } from "../../parse.ts";

/** MacPorts — the second real option on macOS, alongside Homebrew. Install commands need `sudo` (MacPorts, unlike brew, expects root). */
export const makePortBackend = (): PackageManagerBackend => ({
  id: "port",
  list: (exec) =>
    exec({ command: Sh.sh("port", "installed"), shell: true }).pipe(
      Effect.map((result) =>
        firstTokens(
          // `port installed` prints a "The following ports are currently
          // installed:" header line, then one indented
          // `<name> @<version>_<revision> (active)` line per port. Only the
          // version-bearing lines are ports, so filter on the `@` that always
          // separates name from version before ever taking a first token —
          // `firstTokens` alone can't tell the header apart from a real
          // entry.
          lines(result.stdout).filter((line) => line.includes("@")),
        ),
      ),
    ),
  install: (name, exec) =>
    exec({
      command: Sh.sh("sudo", "port", "install", name),
      shell: true,
      timeout: "10 minutes",
    }).pipe(Effect.asVoid),
});
