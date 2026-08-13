import * as Layer from "effect/Layer";
import { PackageProvider } from "./Package.ts";
import { RepoProvider } from "./Repo.ts";

/**
 * Registers `System.Package` and `System.Repo`.
 *
 * Both are built on `@machine-run/engine`'s `toProvider`, whose generated
 * `reconcile` unconditionally resolves `CommandExecutor`, `Backups` and
 * `FileLock` — even though neither resource here sets `snapshotBeforeApply`
 * or ever calls `ctx.snapshot`. Those services are not provided here: the
 * composing recipe supplies one shared `CommandExecutor` (and
 * `@machine-run/core`'s `services()` for `Backups`/`FileLock`) for every
 * command-shaped resource, the same way `@machine-run/dotfiles` and
 * `@machine-run/secrets` leave them to bubble up rather than building a
 * private instance per package.
 */
export const providers = () => Layer.mergeAll(PackageProvider(), RepoProvider());
