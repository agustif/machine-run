import * as Layer from "effect/Layer";
import { DirectoryProvider } from "./Directory.ts";
import { DownloadProvider } from "./Download.ts";
import { ExecProvider } from "./Exec.ts";
import { FileProvider } from "./File.ts";
import { ManagedBlockProvider } from "./ManagedBlock.ts";
import { SymlinkProvider } from "./Symlink.ts";

/**
 * All six dotfiles resource providers, sharing one set of machine services.
 *
 * The shared `FileLock` is the load-bearing part: `Machine.File`,
 * `Machine.ManagedBlock`, `Machine.Symlink`, `Machine.Directory` and
 * `Machine.Download` can all target the same path, and Alchemy reconciles
 * independent resources concurrently. They must draw their locks from one
 * table, which means `@machine-run/core`'s `services()` is provided **once**,
 * here, beneath all six.
 *
 * `Machine.Download` additionally requires an `HttpClient` and `Machine.Exec`
 * requires nothing beyond what the others already need — neither is provided
 * here. `HttpClient` comes from Alchemy's own `StackServices` (see
 * `alchemy/src/Stack.ts`, backed by `FetchHttpClient.layer`) the same way
 * `FileSystem`/`Path` do for every resource in this file, so a real stack
 * needs no extra wiring; a test that builds `makeDownloadReconciler` directly
 * has to supply one itself (see `test/Download.test.ts`).
 */
export const providers = () =>
  Layer.mergeAll(
    DirectoryProvider(),
    DownloadProvider(),
    ExecProvider(),
    FileProvider(),
    ManagedBlockProvider(),
    SymlinkProvider(),
  );
