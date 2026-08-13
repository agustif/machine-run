import * as Layer from "effect/Layer";
import { RuntimeToolProvider } from "./Tool.ts";

/**
 * Registers `Runtime.Tool`.
 *
 * Its generated `reconcile` (from `@machine-run/engine`'s `toProvider`)
 * unconditionally resolves `CommandExecutor`, `Backups` and `FileLock`, and
 * `makeRuntimeToolReconciler` itself resolves `MachinePaths`, `FileSystem`
 * and `Path`. None are provided here — the composing recipe supplies one
 * shared instance of each for every command-shaped resource, the same way
 * `@machine-run/system-packages`, `@machine-run/dotfiles` and
 * `@machine-run/secrets` leave them to bubble up rather than building a
 * private instance per package.
 */
export const providers = () => Layer.mergeAll(RuntimeToolProvider());
