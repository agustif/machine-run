import * as Effect from "effect/Effect";
import type { CommandExecutorService, PackageManagerBackend } from "../Backend.ts";

/**
 * Debian/Ubuntu. `install`/`addRepo` run as root — on a server this means
 * either running machine-run as root or having passwordless sudo configured
 * for these commands; a `sudo` that prompts interactively will hang, since
 * nothing here feeds it a terminal or a password.
 */
export const makeAptBackend = (executor: CommandExecutorService): PackageManagerBackend => ({
  id: "apt",
  list: (session) =>
    executor
      .run({ command: "dpkg-query -f '${binary:Package}\\n' -W", shell: true }, session)
      .pipe(Effect.map((result) => result.stdout.split("\n").filter(Boolean))),
  install: (name, session) =>
    executor
      .run(
        { command: `sudo apt-get install -y ${name}`, timeout: "10 minutes" },
        session,
      )
      .pipe(Effect.asVoid),
  addRepo: (repo, session) =>
    executor
      .run({ command: `sudo add-apt-repository -y ${repo}` }, session)
      .pipe(Effect.asVoid),
});
