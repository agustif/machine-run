import { CommandExecutor } from "alchemy/Command";
import * as Effect from "effect/Effect";
import type { PackageManagerBackend } from "../Backend.ts";

export const makeBrewBackend = (executor: CommandExecutor): PackageManagerBackend => ({
  id: "brew",
  list: (session) =>
    executor
      .run({ command: "brew list --formula" }, session)
      .pipe(Effect.map((result) => result.stdout.split("\n").filter(Boolean))),
  install: (name, session) =>
    executor
      .run({ command: `brew install ${name}`, timeout: "10 minutes" }, session)
      .pipe(Effect.asVoid),
  listRepos: (session) =>
    executor
      .run({ command: "brew tap" }, session)
      .pipe(Effect.map((result) => result.stdout.split("\n").filter(Boolean))),
  addRepo: (repo, session) =>
    executor.run({ command: `brew tap ${repo}` }, session).pipe(Effect.asVoid),
});

export const makeBrewCaskBackend = (executor: CommandExecutor): PackageManagerBackend => ({
  id: "brew-cask",
  list: (session) =>
    executor
      .run({ command: "brew list --cask" }, session)
      .pipe(Effect.map((result) => result.stdout.split("\n").filter(Boolean))),
  install: (name, session) =>
    executor
      .run({ command: `brew install --cask ${name}`, timeout: "10 minutes" }, session)
      .pipe(Effect.asVoid),
});
