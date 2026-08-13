import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

/**
 * Serialises writes to a single path, so that resources which read-modify-write
 * the same file cannot interleave and lose each other's changes.
 *
 * Alchemy applies resources with `concurrency: "unbounded"`: any two resources
 * whose props do not reference each other's outputs reconcile in parallel.
 * Several machine-run resources converge a file by reading it, splicing in a
 * region, and writing the whole file back. Two such resources targeting one
 * path will interleave their read and write, and the write that lands second
 * overwrites the first with content read before the first ever ran. The deploy
 * reports success and the file is silently missing a region.
 *
 * A single file can be targeted by several resource types at once — one
 * managed region per git persona in `~/.gitconfig`, one per host in
 * `~/.ssh/config` — so the exclusion must hold across resource types, not just
 * within one.
 */
export class FileLock extends Context.Service<
  FileLock,
  {
    readonly withLock: <A, E, R>(
      path: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("machine-run/FileLock") {}

/**
 * One lock per path, for the lifetime of the process.
 *
 * The invariant being protected — "one writer at a time per file" — is a
 * property of the filesystem, not of any particular layer, so the table that
 * enforces it lives at process scope. Locks drawn from two different tables
 * exclude nothing, so scoping this per layer instance would make the guarantee
 * depend on how a recipe happened to compose its layers.
 */
const locks = new Map<string, Semaphore.Semaphore>();

const lockFor = (path: string): Semaphore.Semaphore => {
  const existing = locks.get(path);
  if (existing !== undefined) return existing;
  // `makeUnsafe` keeps acquisition of the table entry a single synchronous
  // step. An effectful constructor would introduce a suspension between the
  // failed lookup and the insert, during which a second fiber could look up
  // the same missing key and install a competing semaphore.
  const created = Semaphore.makeUnsafe(1);
  locks.set(path, created);
  return created;
};

export const FileLockLive = () =>
  Layer.succeed(FileLock, {
    withLock: (path, effect) => lockFor(path).withPermits(1)(effect),
  });
