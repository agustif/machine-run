import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type { BackendError } from "./Backend.ts";

/**
 * A memoized string-list cache keyed by an arbitrary string (here, always a
 * package-manager id). One `list`/`listRepos` shell-out per key for the
 * lifetime of the provider, not one per resource.
 *
 * Backed by `effect/Cache` (`Cache.make`/`Cache.get`/`Cache.invalidate`)
 * rather than a hand-rolled `Map`: `Cache.get` de-duplicates concurrent calls
 * for the same missing key by sharing the one in-flight lookup, which a plain
 * `Ref<Map<...>>` cannot do without reimplementing exactly the machinery
 * `Cache` already provides.
 */
export interface MemoizedLister {
  /**
   * Returns the cached list for `key`, calling `fetch` only on the first
   * request for that key (or the first after an `invalidate`). Concurrent
   * callers for the same uncached key share that one call to `fetch` — they
   * do not each trigger it.
   */
  readonly get: (
    key: string,
    fetch: () => Effect.Effect<string[], BackendError>,
  ) => Effect.Effect<string[], BackendError>;
  /** Drops `key`'s cached entry, so the next `get` re-fetches. */
  readonly invalidate: (key: string) => Effect.Effect<void>;
}

const makeMemoizedLister: Effect.Effect<MemoizedLister> = Effect.gen(function* () {
  // `Cache.make`'s `lookup` is one function fixed for the cache's whole
  // lifetime, keyed only on `key` — it has no way to accept a different
  // `fetch` thunk per `get` call the way this module's own `get` does (`diff`
  // and `reconcile` each close over a different session when they call
  // `get`). This ref is the seam that bridges the two: `get` records `fetch`
  // here immediately before asking the cache for `key`, and `lookup` below
  // reads it back in the same synchronous step. It never stores results —
  // only which thunk to run on the next actual miss — so it is not a
  // second cache; hit/miss decisions, concurrent de-duplication, and
  // invalidation all live in `Cache` itself.
  const fetchers = yield* Ref.make(new Map<string, () => Effect.Effect<string[], BackendError>>());

  const cache = yield* Cache.make<string, string[], BackendError>({
    // A handful of package-manager ids exist in total (brew, apt, dnf,
    // pacman, cargo, npm, winget, choco, ...) — this is not sized for
    // eviction, just large enough that a real deployment never approaches it.
    capacity: 256,
    lookup: (key) =>
      Effect.gen(function* () {
        const fetch = (yield* Ref.get(fetchers)).get(key);
        // Unreachable in practice: `get` below always registers a fetcher
        // for `key` before asking the cache for it, so a miss always finds
        // one. Guards against this module being used outside that contract
        // rather than a real runtime condition.
        if (!fetch) {
          return yield* Effect.die(
            `PackageIndex: no fetcher registered for "${key}" — get() must register one before querying the cache`,
          );
        }
        return yield* fetch();
      }),
  });

  const get: MemoizedLister["get"] = (key, fetch) =>
    Effect.gen(function* () {
      yield* Ref.update(fetchers, (map) => new Map(map).set(key, fetch));
      return yield* Cache.get(cache, key);
    });

  const invalidate = (key: string) => Cache.invalidate(cache, key);

  return { get, invalidate };
});

/**
 * A pair of memoized `list`/`listRepos` caches for `Package.ts`/`Repo.ts` to
 * wire their backends through.
 *
 * Listing installed packages is a real shell-out (`brew list`,
 * `dpkg-query`, …) that returns the manager's entire installed set, so it is
 * answered once per manager per phase rather than once per declared package:
 * without memoization, 100 packages on one manager means 100 identical
 * listings. `packages` and `repos` are separate
 * `MemoizedLister`s (not one shared by key) because a manager id like
 * `"brew"` means two different things depending on which one is asked —
 * installed formula names vs. tapped repos — and collapsing them into one
 * keyspace would let a repo listing satisfy a package lookup (or vice versa).
 *
 * ## The plan-phase and apply-phase caches must NOT be one shared instance
 *
 * `Package.ts`/`Repo.ts` each construct **two** of these (see their
 * `planIndex`/`applyIndex`), not one shared instance, even though both are
 * built once per provider (and so live for the same process). `@machine-run/
 * engine`'s `toProvider` calls a reconciler's `observe` from two distinct
 * moments: once per resource, up front, to build the whole plan (`diff`/
 * `read`, passing an `ObserveContext`), and again, per resource, immediately
 * before deciding whether to `apply` (`reconcile`'s re-observe, passing an
 * `ApplyContext`). Planning and applying are not adjacent in time — a human
 * can review a plan before confirming it, or run `alchemy plan` and `apply`
 * as separate commands — so if a "was it installed?" answer computed during
 * the plan-phase `observe` were reused by the apply-phase one, a package
 * uninstalled by something else during that gap would still read as present:
 * the plan-phase call would have cached "present" before the uninstall
 * happened, and the apply-phase call would then reuse that stale entry
 * instead of re-listing, so the very drift this caching sits alongside would
 * silently survive an entire apply. Two independent instances mean the worst
 * case is one extra real listing per manager per phase instead of the
 * original N-per-resource — still the fix this module exists for — while
 * keeping the apply-phase view of "what's installed" honestly independent of
 * whatever planning saw earlier. `Package.ts`/`Repo.ts` tell the two phases
 * apart by whether the `ObserveContext` they were given is actually the wider
 * `ApplyContext` (checking for `snapshot`, which only the latter has).
 */
export interface PackageIndex {
  readonly packages: MemoizedLister;
  readonly repos: MemoizedLister;
}

export const makePackageIndex: Effect.Effect<PackageIndex> = Effect.gen(function* () {
  const packages = yield* makeMemoizedLister;
  const repos = yield* makeMemoizedLister;
  return { packages, repos };
});
