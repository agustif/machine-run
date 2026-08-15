import { NodeCrypto } from "@effect/platform-node";
import * as Layer from "effect/Layer";
import { BackupsLive } from "./Backups.ts";
import { FileLockLive } from "./FileLock.ts";
import { MachinePathsLive } from "./Paths.ts";
import { PlatformLive } from "./Platform.ts";

/**
 * The machine-wide services every file-touching package depends on: where `~`
 * resolves to, where this run's backups are written, the lock that serialises
 * writes to a shared file, and the crypto implementation content hashing uses.
 *
 * Provide this once per stack, beneath the resource providers.
 *
 * `Crypto` is included because Alchemy's `StackServices` does not carry it —
 * the stack supplies `FileSystem`, `Path`, `HttpClient` and
 * `ChildProcessSpawner`, but hashing is not something it needs itself, so
 * nothing else would.
 */
export const services = () =>
  Layer.mergeAll(BackupsLive(), FileLockLive(), NodeCrypto.layer)
    .pipe(Layer.provideMerge(MachinePathsLive()))
    .pipe(Layer.provideMerge(PlatformLive()));
