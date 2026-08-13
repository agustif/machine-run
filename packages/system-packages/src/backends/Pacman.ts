import { CommandExecutor } from "alchemy/Command";
import * as Effect from "effect/Effect";
import type { PackageManagerBackend } from "../Backend.ts";

/** Arch Linux. Same sudo caveat as Apt.ts. No AUR support (that needs a separate helper like yay/paru). */
export const makePacmanBackend = (executor: CommandExecutor): PackageManagerBackend => ({
  id: "pacman",
  list: (session) =>
    executor
      .run({ command: "pacman -Qq" }, session)
      .pipe(Effect.map((result) => result.stdout.split("\n").filter(Boolean))),
  install: (name, session) =>
    executor
      .run({ command: `sudo pacman -S --noconfirm ${name}`, timeout: "10 minutes" }, session)
      .pipe(Effect.asVoid),
});
