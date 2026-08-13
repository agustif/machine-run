import { CommandExecutorLive } from "alchemy/Command";
import * as Layer from "effect/Layer";
import { PackageProvider } from "./Package.ts";
import { RepoProvider } from "./Repo.ts";

export const providers = () =>
  Layer.mergeAll(PackageProvider(), RepoProvider()).pipe(Layer.provide(CommandExecutorLive()));
