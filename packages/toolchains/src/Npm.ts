import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import { CommandExecutor } from "alchemy/Command";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";

export interface NpmGlobalPackagesProps {
  /** Desired `npm install -g`ed package names, e.g. ["typescript", "pnpm"]. */
  packages: string[];
}

export interface NpmGlobalPackages
  extends Resource<"Toolchain.NpmGlobalPackages", NpmGlobalPackagesProps, { packages: string[] }> {}

export const NpmGlobalPackages = Resource<NpmGlobalPackages>("Toolchain.NpmGlobalPackages");

interface NpmLsOutput {
  dependencies?: Record<string, unknown>;
}

export const NpmGlobalPackagesProvider = () =>
  Provider.effect(
    NpmGlobalPackages,
    Effect.gen(function* () {
      const executor = yield* CommandExecutor;

      const listInstalled = (session: ScopedPlanStatusSession) =>
        Effect.gen(function* () {
          const result = yield* executor.run(
            { command: "npm ls -g --depth=0 --json" },
            session,
          );
          const parsed = yield* Effect.try(() => JSON.parse(result.stdout) as NpmLsOutput);
          return Object.keys(parsed.dependencies ?? {});
        });

      return NpmGlobalPackages.Provider.of({
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
          if (!output) return { action: "update" as const };
          const satisfied = news.packages.every((pkg) => output.packages.includes(pkg));
          if (!satisfied) return { action: "update" as const };
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          const current = yield* listInstalled(session);
          const missing = news.packages.filter((pkg) => !current.includes(pkg));
          for (const pkg of missing) {
            yield* executor.run(
              { command: `npm install -g ${pkg}`, timeout: "5 minutes" },
              session,
            );
          }
          const final = missing.length > 0 ? yield* listInstalled(session) : current;
          return { packages: final };
        }),
        // Never uninstalls — additive only, same rationale as Cargo.ts.
        delete: () => Effect.void,
      });
    }),
  );
