import { CommandExecutor } from "alchemy/Command";

/**
 * The resolved shape of `CommandExecutor` — what `yield* CommandExecutor`
 * produces, as opposed to the class itself, which types as the service key.
 *
 * Effect 4 exposes this as the key's own `.Service` property. There is no
 * `Context.Tag` namespace in Effect 4; referring to one resolves to `unknown`,
 * which then propagates silently into every consumer rather than failing where
 * it is written.
 */
export type CommandExecutorService = typeof CommandExecutor.Service;
