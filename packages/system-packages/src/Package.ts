import { CommandExecutor } from "alchemy/Command";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { makeAptBackend } from "./backends/Apt.ts";
import { makeBrewBackend, makeBrewCaskBackend } from "./backends/Brew.ts";
import { makeCargoBackend } from "./backends/Cargo.ts";
import { makeDnfBackend } from "./backends/Dnf.ts";
import { makePortBackend } from "./backends/MacPorts.ts";
import { makeNpmBackend } from "./backends/Npm.ts";
import { makePacmanBackend } from "./backends/Pacman.ts";
import type { PackageManagerBackend } from "./Backend.ts";

export type PackageManagerId =
  | "brew"
  | "brew-cask"
  | "port"
  | "apt"
  | "dnf"
  | "pacman"
  | "cargo"
  | "npm";

export interface PackageProps {
  manager: PackageManagerId;
  /** The package's name in that manager's own namespace, e.g. "mise", "cargo-bloat", "@opencode-ai/cli". */
  name: string;
}

/**
 * One installed package, from one manager. This is the atomic unit
 * everything else composes from — there is deliberately no "bundle" resource
 * that owns a whole list; a role/recipe just declares one `Package` per
 * package it wants, the same way alchemy's own resources are always one
 * cloud object each (never "the AWS.S3.Bucket resource that owns all your
 * buckets").
 */
export interface Package
  extends Resource<"System.Package", PackageProps, { manager: string; name: string }> {}

export const Package = Resource<Package>("System.Package");

export const PackageProvider = () =>
  Provider.effect(
    Package,
    Effect.gen(function* () {
      const executor = yield* CommandExecutor;
      const backends: Record<PackageManagerId, PackageManagerBackend> = {
        brew: makeBrewBackend(executor),
        "brew-cask": makeBrewCaskBackend(executor),
        port: makePortBackend(executor),
        apt: makeAptBackend(executor),
        dnf: makeDnfBackend(executor),
        pacman: makePacmanBackend(executor),
        cargo: makeCargoBackend(executor),
        npm: makeNpmBackend(executor),
      };

      return Package.Provider.of({
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
          if (!output || output.manager !== news.manager || output.name !== news.name) {
            return { action: "update" as const };
          }
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          const backend = backends[news.manager];
          const installed = yield* backend.list(session);
          if (!installed.includes(news.name)) {
            yield* backend.install(news.name, session);
          }
          return { manager: news.manager, name: news.name };
        }),
        // Never uninstalls — additive only, matching every other machine-run resource.
        delete: () => Effect.void,
      });
    }),
  );
