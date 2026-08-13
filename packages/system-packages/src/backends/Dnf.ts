import { CommandExecutor } from "alchemy/Command";
import * as Effect from "effect/Effect";
import type { PackageManagerBackend } from "../Backend.ts";

/** Fedora/RHEL. Same sudo caveat as Apt.ts. */
export const makeDnfBackend = (executor: CommandExecutor): PackageManagerBackend => ({
  id: "dnf",
  list: (session) =>
    executor
      .run({ command: "dnf repoquery --userinstalled --qf '%{name}\\n'", shell: true }, session)
      .pipe(Effect.map((result) => result.stdout.split("\n").filter(Boolean))),
  install: (name, session) =>
    executor
      .run({ command: `sudo dnf install -y ${name}`, timeout: "10 minutes" }, session)
      .pipe(Effect.asVoid),
});
