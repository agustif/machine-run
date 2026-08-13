import { CommandExecutorLive } from "alchemy/Command";
import * as Layer from "effect/Layer";
import { MacDefaultProvider } from "./Default.ts";

export const providers = () =>
  Layer.mergeAll(MacDefaultProvider()).pipe(Layer.provide(CommandExecutorLive()));
