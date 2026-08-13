import * as Layer from "effect/Layer";
import { McpServerProvider } from "./McpServer.ts";

/**
 * `Ai.McpServer`'s provider — the only resource this package defines.
 * `Ai.Skill`/`Ai.Config` are pure compositions over `Dotfiles.Symlink` (see
 * `Skill.ts`/`Config.ts`), so their providers are `@machine-run/dotfiles`'s
 * `SymlinkProvider`, already included in `Dotfiles.providers()` — a recipe
 * using this package still needs that layer, the same way
 * `packages/ssh/src/Host.ts`'s `sshHost` needs `Dotfiles.providers()` for
 * `Machine.ManagedBlock`.
 */
export const providers = () => Layer.mergeAll(McpServerProvider());
