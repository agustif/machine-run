import * as Layer from "effect/Layer";
import { LoginProvider } from "./Login.ts";

/**
 * Registers `Shell.Login` — the only real resource in this package.
 * `envVar`/`pathEntry`/`alias`/`hook`/`ensureLoginShellLoadsRc` are
 * composition functions over `Dotfiles.ManagedBlock` and need no provider of
 * their own; `@machine-run/dotfiles`'s `providers()` already registers it.
 *
 * `Shell.Login`'s generated `reconcile` (via `toProvider`) resolves
 * `CommandExecutor`, `Backups` and `FileLock` even though it never sets
 * `snapshotBeforeApply`. Those aren't provided here — the composing recipe
 * supplies one shared `CommandExecutor` (and `@machine-run/core`'s
 * `services()` for `Backups`/`FileLock`) for every command-shaped resource,
 * the same convention `system-packages` and `secrets` follow.
 */
export const providers = () => Layer.mergeAll(LoginProvider());
