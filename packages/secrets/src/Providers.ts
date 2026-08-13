import { CommandExecutorLive } from "alchemy/Command";
import * as Layer from "effect/Layer";
import { OnePasswordLive } from "./OnePassword.ts";
import { SecretFileProvider } from "./SecretFile.ts";

// Provides CommandExecutorLive locally (mirroring alchemy's own
// `Command/Providers.ts`) so this package's OnePassword dependency resolves
// on its own, regardless of whether the app-level recipe also happens to
// include `Command.providers()`.
export const providers = () =>
  Layer.mergeAll(SecretFileProvider()).pipe(
    Layer.provide(OnePasswordLive()),
    Layer.provide(CommandExecutorLive()),
  );
