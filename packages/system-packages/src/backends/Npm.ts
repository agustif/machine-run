import { CommandExecutor } from "alchemy/Command";
import * as Effect from "effect/Effect";
import { BackendParseError, type PackageManagerBackend } from "../Backend.ts";

interface NpmLsOutput {
  dependencies?: Record<string, unknown>;
}

export const makeNpmBackend = (executor: CommandExecutor): PackageManagerBackend => ({
  id: "npm",
  list: (session) =>
    Effect.gen(function* () {
      const result = yield* executor.run({ command: "npm ls -g --depth=0 --json" }, session);
      const parsed = yield* Effect.try({
        try: () => JSON.parse(result.stdout) as NpmLsOutput,
        catch: (cause) => new BackendParseError({ cause }),
      });
      return Object.keys(parsed.dependencies ?? {});
    }),
  install: (name, session) =>
    executor
      .run({ command: `npm install -g ${name}`, timeout: "5 minutes" }, session)
      .pipe(Effect.asVoid),
});
