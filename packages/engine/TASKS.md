# `@machine-run/engine` — backlog

`Reconciler` → Alchemy provider. Where the uniform decisions are made once.
See [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

- **Decided against: a generic engine-level reuse of the plan-phase
  observation via Alchemy's `Artifacts`.** `toProvider` calls `observe`
  once in `diff` and again inside `reconcile`, immediately before a
  possible `apply`. For a filesystem resource that second call is a cheap
  `stat`; for `System.Package` or `Tailscale.Connection` it's a second
  shell-out per resource, which looks like free savings. It isn't, at the
  adapter level: `packages/system-packages/src/Package.ts` already solved
  this problem for itself, deliberately, with **two independent**
  memoized listings (`planIndex`/`applyIndex`) rather than one shared
  cache — because a package uninstalled by something else between a
  human reviewing a plan and confirming it (an `alchemy plan` followed by
  a separate `apply`) would otherwise still read as present: the
  plan-time observation populated the cache while the package still
  existed, and the apply-time re-observe would reuse that stale entry
  instead of re-listing, silently surviving the very drift the caching
  exists alongside.

      A generic `toProvider`-level cache keyed only on `address` would have
      to make the *same* plan/apply distinction to be safe — which is just
      reimplementing `Package.ts`'s two-instance split inside the adapter,
      except now guessing, per resource type, whether a plan-phase result is
      cheap enough to be worth caching at all (a `stat` gains nothing; a
      shell-out does) without knowing what "expensive" means for a reconciler
      the adapter has never seen. That's a per-reconciler decision, not a
      uniform one — `Package.ts` already makes it correctly at its own level,
      and a generic version below it would either save nothing (the common
      case) or have to rebuild the same staleness-aware split to stay safe,
      with none of the resource-specific knowledge that makes `Package.ts`'s
      version actually correct (e.g., invalidating just the touched manager's
      entry after `apply`, not the whole cache). Shipping a subtly-unsafe
      generic version would be worse than not shipping one.

- [x] **Action was audited and deliberately declined.** An imperative one-shot
      has no observe/idempotence boundary; `Machine.Exec` covers the stateful
      form through an explicit guard. `MacOS.Default` keeps its optional
      best-effort app restart local to the write it makes, rather than exposing
      a graph node that can fire on every deploy.
- [x] **RemovalPolicy decisions are recorded per resource.** The adapter only
      invokes `unapply` for explicit `destroy`, and the current 16/23 split is
      documented in each reconciler; the seven refusals are intentional because
      no exact or safe reverse exists. New resources must make the same choice.
- [ ] **`address` collision audit.** Two resources sharing an address serialise
      against each other, which is correct for contention but wrong if the
      addresses collide by accident. Nothing detects that today.
- [ ] Tests for the adapter itself: that `diff` is derived from
      `observe`+`matches`, that snapshots happen on first apply and on adoption
      but not on a routine update, and that applies to one address serialise.
