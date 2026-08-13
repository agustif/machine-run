# `@machine-run/engine` — backlog

`Reconciler` → Alchemy provider. Where the uniform decisions are made once.
See [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

- [ ] **`observe` should return `Option<State>`.** `State | undefined` is our
      own contract, not Alchemy's, and it is the single largest contributor to
      the `noNullish` count. The adapter converts to `undefined` once, at the
      Alchemy boundary where it genuinely is required (`read`'s and `diff`'s
      return values). `ApplyInput.observed` becomes `Option<State>` too, all
      the way into `apply`; `matches`, `unapply`'s `observed`/`recorded`, and
      `ApplyContext.snapshot`'s return stay as they are — they're already
      non-optional or already `string | undefined` for an unrelated reason.

      **This is an atomic, repo-wide change — it cannot land incrementally.**
      `Option`'s runtime shape (`{ _tag: "Some", value }` / `{ _tag: "None" }`)
      isn't compatible with `undefined`/a bare value, so the moment
      `Reconciler.observe`'s declared return type changes, every existing
      implementation fails to type-check until it's updated in the same
      commit. A prototype of this was built and fully reverted on
      2026-08-13 specifically because five other agents had uncommitted,
      in-flight work in exactly the files it would have touched — landing it
      then would have clobbered that work or forced a re-do against a moving
      target. It's safe once the tree is quiet. The full list of call sites
      that have to change together, so whoever picks this up doesn't have to
      rediscover it:

      - `packages/engine/src/Reconciler.ts` — `Reconciler.observe`'s return
        type; `ApplyInput.observed`'s type.
      - `packages/engine/src/toProvider.ts` — `read` (`Option.getOrUndefined`
        at the return), `diff` (`Option.isNone`/`.value`), `reconcile`
        (`Option.isSome`/`.value`, `observed` passed through to `apply` as
        `Option`).
      - `packages/dotfiles/src/File.ts`, `ManagedBlock.ts`, `Symlink.ts`,
        `Directory.ts`, `Download.ts`, `Exec.ts` — each `observe`.
      - `packages/macos-defaults/src/Default.ts` — `observe`.
      - `packages/secrets/src/SecretFile.ts` — `observe`.
      - `packages/system-packages/src/Package.ts`, `Repo.ts` — each `observe`
        (note `Package.ts`'s `isApplyPhase`-gated `planIndex`/`applyIndex`
        split stays exactly as it is; only the wrapped return value changes).
      - `packages/tailscale/src/Connection.ts` — `observe`.
      - Every package's own test file that constructs a reconciler's
        `observe` result directly (not just the provider-level ones) needs
        the same `Option.some`/`Option.none()` swap.

      Mechanical per call site: `return undefined` → `return Option.none()`;
      `return { ... }` → `return Option.some({ ... })`; a `.pipe`-chained
      `Effect.map`/`orElseSucceed` returning `undefined` becomes
      `Option.none()` the same way. No reconciler's actual observation logic
      needs to change, only how "nothing here" and "here it is" are spelled.
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
- [ ] **Bridge `Action`** for side effects that are not state: `killall Dock`
      after a `defaults write` batch, `brew update`. Today `MacOS.Default` runs
      `killall` inside its own apply, so eight dock settings can restart the
      Dock eight times.
- [ ] **Finish `RemovalPolicy`.** The mechanism exists; the policy does not.
      Decide per resource whether it can honestly reverse itself, and make the
      ones that cannot say so rather than silently doing nothing.
- [ ] **`address` collision audit.** Two resources sharing an address serialise
      against each other, which is correct for contention but wrong if the
      addresses collide by accident. Nothing detects that today.
- [ ] Tests for the adapter itself: that `diff` is derived from
      `observe`+`matches`, that snapshots happen on first apply and on adoption
      but not on a routine update, and that applies to one address serialise.
