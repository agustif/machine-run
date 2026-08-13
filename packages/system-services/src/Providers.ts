import * as Layer from "effect/Layer";
import { ServiceProvider } from "./Service.ts";

/**
 * Registers `System.Service`.
 *
 * Its generated `reconcile` (from `@machine-run/engine`'s `toProvider`)
 * unconditionally resolves `CommandExecutor`, `Backups` and `FileLock`, and
 * `makeServiceReconciler` itself resolves `MachinePaths`, `FileSystem` and
 * `Path`. None are provided here — the composing recipe supplies one shared
 * instance of each for every command-shaped resource, the same way
 * `@machine-run/runtimes`, `@machine-run/system-packages` and
 * `@machine-run/system-settings` leave them to bubble up rather than
 * building a private instance per package.
 */
export const providers = () => Layer.mergeAll(ServiceProvider());
