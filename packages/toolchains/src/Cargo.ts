import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import { CommandExecutor } from "alchemy/Command";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";

export interface CargoPackagesProps {
  /** Desired `cargo install`ed binary crates, e.g. ["cargo-bloat", "cargo-fuzz", "flamegraph"]. */
  packages: string[];
}

export interface CargoPackages
  extends Resource<"Toolchain.CargoPackages", CargoPackagesProps, { packages: string[] }> {}

export const CargoPackages = Resource<CargoPackages>("Toolchain.CargoPackages");

export const CargoPackagesProvider = () =>
  Provider.effect(
    CargoPackages,
    Effect.gen(function* () {
      const executor = yield* CommandExecutor;

      const listInstalled = (session: ScopedPlanStatusSession) =>
        executor.run({ command: "cargo install --list" }, session).pipe(
          Effect.map((result) =>
            result.stdout
              .split("\n")
              // `cargo install --list` prints "name vX.Y.Z:" for each crate,
              // then indented lines for its installed binaries.
              .filter((line) => line.length > 0 && !line.startsWith(" "))
              .map((line) => line.split(" ")[0]),
          ),
        );

      return CargoPackages.Provider.of({
        list: () => Effect.succeed([]),
        // Cheap hint against the last recorded state — reconcile always
        // re-observes the live installed list before deciding what to run.
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
              { command: `cargo install ${pkg}`, timeout: "10 minutes" },
              session,
            );
          }
          const final = missing.length > 0 ? yield* listInstalled(session) : current;
          return { packages: final };
        }),
        // Never uninstalls a crate that's no longer in `packages` — only
        // ever additive, matching the Homebrew bundle's default behavior.
        delete: () => Effect.void,
      });
    }),
  );
