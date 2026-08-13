import * as Layer from "effect/Layer";
import { SettingProvider } from "./Setting.ts";

/**
 * Registers `System.Setting`.
 *
 * `toProvider`'s generated `reconcile` unconditionally resolves
 * `CommandExecutor`, `Backups` and `FileLock` — even though this resource
 * never sets `snapshotBeforeApply` or calls `ctx.snapshot`. None of those are
 * provided here: the composing recipe supplies one shared `CommandExecutor`
 * (and `@machine-run/core`'s `services()` for `Backups`/`FileLock`) for every
 * command-shaped resource, the same way `@machine-run/system-packages` and
 * `@machine-run/secrets` leave them to bubble up rather than each building a
 * private instance.
 */
export const providers = () => Layer.mergeAll(SettingProvider());
