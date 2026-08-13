import * as Layer from "effect/Layer";
import { CommandExecutorLive } from "alchemy/Command";
import { CargoPackagesProvider } from "./Cargo.ts";
import { NpmGlobalPackagesProvider } from "./Npm.ts";

// Self-sufficient for its own CommandExecutor dependency, same rationale as
// packages/secrets/Providers.ts.
export const providers = () =>
  Layer.mergeAll(CargoPackagesProvider(), NpmGlobalPackagesProvider()).pipe(
    Layer.provide(CommandExecutorLive()),
  );
