import * as Effect from "effect/Effect";
import type { CommandExecutorService, PackageManagerBackend } from "../Backend.ts";

export const makeCargoBackend = (executor: CommandExecutorService): PackageManagerBackend => ({
  id: "cargo",
  list: (session) =>
    executor.run({ command: "cargo install --list" }, session).pipe(
      Effect.map((result) =>
        result.stdout
          .split("\n")
          // `cargo install --list` prints "name vX.Y.Z:" per crate, then
          // indented lines for its installed binaries.
          .filter((line) => line.length > 0 && !line.startsWith(" "))
          .map((line) => line.split(" ")[0]),
      ),
    ),
  install: (name, session) =>
    executor
      .run({ command: `cargo install ${name}`, timeout: "10 minutes" }, session)
      .pipe(Effect.asVoid),
});
