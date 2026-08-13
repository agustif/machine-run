import { OnePasswordLive } from "@machine-run/secrets";
import { CommandExecutorLive } from "alchemy/Command";
import * as Layer from "effect/Layer";
import { TailscaleConnectionProvider } from "./Connection.ts";

export const providers = () =>
  Layer.mergeAll(TailscaleConnectionProvider()).pipe(
    Layer.provide(OnePasswordLive()),
    Layer.provide(CommandExecutorLive()),
  );
