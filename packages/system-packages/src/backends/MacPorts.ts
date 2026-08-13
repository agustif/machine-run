import * as Effect from "effect/Effect";
import type { CommandExecutorService, PackageManagerBackend } from "../Backend.ts";

/** MacPorts — the second real option on macOS, alongside Homebrew. Install commands need `sudo` (MacPorts, unlike brew, expects root). */
export const makePortBackend = (executor: CommandExecutorService): PackageManagerBackend => ({
  id: "port",
  list: (session) =>
    executor
      .run({ command: "port installed", shell: true }, session)
      .pipe(
        Effect.map((result) =>
          result.stdout
            .split("\n")
            .filter((line) => line.trim().startsWith("@") === false && line.includes("@"))
            .map((line) => line.trim().split(" ")[0]),
        ),
      ),
  install: (name, session) =>
    executor
      .run({ command: `sudo port install ${name}`, timeout: "10 minutes" }, session)
      .pipe(Effect.asVoid),
});
