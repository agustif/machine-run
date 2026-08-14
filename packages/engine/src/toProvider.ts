import { Backups, FileLock, silentSession } from "@machine-run/core";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import { CommandExecutor } from "alchemy/Command";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { RemovalPolicy } from "alchemy/RemovalPolicy";
import type { ResourceClassLike, ResourceLike } from "alchemy/Resource";
import * as Boolean from "effect/Boolean";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ApplyContext, ObserveContext, Reconciler } from "./Reconciler.ts";

/**
 * Builds the Alchemy provider for a {@link Reconciler}.
 *
 * Everything that is uniform across machine resources is decided here, once:
 *
 * - `diff` observes the machine and compares against desired state. Resources
 *   cannot opt out, so none of them can be blind to changes made by anything
 *   other than this tool.
 * - `read` reports what is already present, which is what lets the engine adopt
 *   a machine that is correct instead of treating it as empty.
 * - `reconcile` serialises on the reconciler's address, snapshots when
 *   requested, and re-observes immediately before applying.
 * - `delete` leaves the machine alone **by default**. Retain, not "delete does
 *   nothing", is the actual invariant — see below.
 *
 * The `session` split is the subtle one. Alchemy threads a status session into
 * `reconcile` but not into `diff` or `read`, because planning has no apply
 * session to report progress to. Rather than exposing that asymmetry to every
 * resource, the observe context always carries a non-reporting session and the
 * apply context carries the live one.
 *
 * ## `delete` and `RemovalPolicy`
 *
 * Every resource here used to hard-code `delete: () => Effect.void` — nothing
 * ever reversed itself, and there was no way to back out of adopting a
 * machine. Alchemy already models the choice a caller might want instead:
 * `RemovalPolicy` (`"retain" | "destroy"`, scoped onto an effect with its
 * `retain(...)`/`destroy(...)` helpers).
 *
 * The generated `delete` reads that policy itself, rather than trusting
 * Alchemy's own gate:
 *
 * - **No explicit policy, or an explicit `"retain"`, is a no-op.** This is
 *   the default read of `Effect.serviceOption(RemovalPolicy)` returning
 *   `None` — deliberately the *opposite* of Alchemy's own fallback (`Resource`
 *   defaults an unset policy to `"destroy"` unless a resource type opts into
 *   `defaultRemovalPolicy: "retain"`, which nothing in this repo does).
 *   Re-deciding the default here, rather than relying on every resource
 *   author remembering to set that option, is what makes "retain" the actual
 *   invariant machine-wide instead of an opt-in per resource type.
 * - **An explicit `"destroy"` calls {@link Reconciler.unapply} — if the
 *   reconciler has one.** No `unapply` is, again, a no-op: most resources
 *   cannot honestly reverse themselves (see its doc comment), and a resource
 *   silently doing nothing is the truthful outcome, not a bug to route
 *   around.
 * - **Alchemy's own `RemovalPolicy` gate is a separate, complementary check**
 *   that happens *before* this ever runs: under a per-resource policy of
 *   `"retain"`, Alchemy's `Apply.ts` skips calling any provider's `delete`
 *   entirely and only clears its own bookkeeping (verified by reading
 *   `Apply.ts` directly — it never threads `RemovalPolicy` into the `delete`
 *   effect's context, so that check and this one are independent layers, not
 *   duplicates). Whether `RemovalPolicy` context actually reaches this
 *   `delete` body depends on *where* a recipe author wraps `retain()`/
 *   `destroy()` — around one resource's registration only sets the field
 *   Alchemy's own gate reads; wrapping the whole stack program is what also
 *   reaches here. **This repo has never run an actual `alchemy destroy`
 *   against a deployed stack, so the propagation path is reasoned from
 *   Alchemy's source, not observed.** Either way the worst case if it does
 *   not reach here is identical to today's behaviour: an unconditional
 *   no-op — this can only ever add an opt-in destructive path, never remove
 *   the safety of the current one.
 *
 * ### Why "restore from backup" is not built in here
 *
 * `@machine-run/core`'s `Backups` looks like the obvious answer to "undo an
 * overwrite" — but its directory is stamped fresh every run
 * (`~/.local/state/machine-run/backups/<this-run's-stamp>/...`), so a
 * `destroy` invocation's own `Backups` service has no idea where a backup
 * taken during some earlier `deploy` landed; that information does not
 * survive between runs unless something persists it. The only thing that
 * *does* survive between runs is a resource's own `State`, round-tripped
 * through Alchemy's state file. So restoring from backup is something an
 * individual reconciler can do — by calling {@link ApplyContext.snapshot}
 * itself during `apply` and folding the returned path into its `State` for
 * `unapply` to read back later — but it is not something this adapter can
 * fabricate on a resource's behalf, and none of the resources in this repo do
 * it yet (that is a per-resource change, owned by whoever writes that
 * resource).
 *
 * ## Relationship to Alchemy
 *
 * This produces an ordinary Alchemy provider — the same `Layer<Provider<Res>>`
 * a hand-written one produces — so Alchemy remains the engine for planning,
 * state, ordering, apply and destroy. It is a constructor for providers, not a
 * layer that resources talk to instead of Alchemy.
 *
 * A {@link Reconciler} deliberately cannot express everything a provider can:
 * there is no `replace`, no `stables`, no `precreate`, and `delete` only ever
 * calls {@link Reconciler.unapply}. A resource that genuinely needs one of
 * those should call `Provider.effect` directly instead of stretching this
 * shape — this is the same call `toProvider` itself makes below, just without
 * the parts every machine resource shares. Both kinds compose in the same
 * stack, because both are just providers.
 */
/**
 * The one shape Alchemy's `diff` uses to say "this resource needs applying".
 * A named constant rather than an inline literal with `as const`. `satisfies`
 * rather than a declared type: it checks the shape while still letting
 * inference keep `action` as `"update"` instead of widening it to `string`,
 * which a declared anonymous target type would discard.
 */
const NEEDS_UPDATE = { action: "update" } satisfies { readonly action: "update" };

export const toProvider = <Res extends ResourceLike, E, R>(
  cls: ResourceClassLike<Res>,
  /**
   * An effect that builds the reconciler, so it can resolve the services it
   * needs once — the same way a provider resolves its dependencies once,
   * rather than per reconcile.
   */
  make: Effect.Effect<Reconciler<Res["Props"], Res["Attributes"], E>, never, R>,
) =>
  Provider.effect(
    cls,
    Effect.gen(function* () {
      const reconciler = yield* make;
      const executor = yield* CommandExecutor;
      const backups = yield* Backups;
      const locks = yield* FileLock;

      const observeCtx: ObserveContext = {
        exec: (props) => executor.run(props, silentSession),
      };

      const applyCtx = (session: ScopedPlanStatusSession): ApplyContext => ({
        exec: (props) => executor.run(props, session),
        snapshot: (path) => backups.snapshot(path),
      });

      const list = reconciler.list;

      return {
        // A reconciler that hasn't been taught to enumerate leaves this key
        // out entirely, rather than this adapter asserting `[]` on its
        // behalf: `Provider.effect`'s own constructor already treats a
        // missing `list` as `() => Effect.succeed([])` (see its doc comment
        // on `ProviderServiceInput`), so the runtime result is identical —
        // what changes is which party is making the claim "nothing here".
        // A reconciler that does implement `list` (none does yet) has its
        // result passed straight through.
        ...(list ? { list: () => list(observeCtx) } : {}),

        // Alchemy's `read` contract is `undefined`-shaped: this is the one
        // place `Option.getOrUndefined` belongs, converting at the boundary
        // rather than pushing the weaker spelling back into the reconciler.
        read: Effect.fn(function* ({ olds }: { olds: Res["Props"] }) {
          return yield* reconciler.observe(olds, observeCtx).pipe(Effect.map(Option.getOrUndefined));
        }),

        diff: Effect.fn(function* ({ news }: { news: Res["Props"] }) {
          // Props can still contain unresolved references to other resources'
          // outputs during planning; there is nothing to compare until they
          // resolve, and the engine will diff again once they do.
          if (!isResolved(news)) return undefined;

          const observed = yield* reconciler.observe(news, observeCtx);
          if (Option.isNone(observed)) return NEEDS_UPDATE;

          const desired = yield* reconciler.desired(news);

          // A reconciler that reports *which* fields drifted gets those turned
          // into Alchemy's own `stables` — the properties it should not expect
          // to change — rather than the bare `update` a boolean can produce.
          // `matches` still decides *whether* to update, so a `drift` that
          // disagreed with its own `matches` cannot cause a spurious apply.
          const changed = reconciler.drift;
          if (changed !== undefined) {
            const fields = changed(observed.value, desired);
            if (fields.length === 0) return undefined;
            const drifted = new Set(fields.map((field) => field.field));
            return {
              action: "update",
              stables: Object.keys(desired).filter((key) => !drifted.has(key)),
            } satisfies { readonly action: "update"; readonly stables: string[] };
          }

          return Boolean.match(reconciler.matches(observed.value, desired), {
            onTrue: () => undefined,
            onFalse: () => NEEDS_UPDATE,
          });
        }),

        reconcile: Effect.fn(function* ({
          news,
          olds,
          output,
          session,
        }: {
          news: Res["Props"];
          olds: Res["Props"] | undefined;
          output: Res["Attributes"] | undefined;
          session: ScopedPlanStatusSession;
        }) {
          const ctx = applyCtx(session);
          const address = reconciler.address(news);

          // Whatever is at this address was not put there by a previous run of
          // this resource in two cases: nothing has been recorded yet, or the
          // engine adopted something it found. Both mean the current contents
          // may be a person's own work, and are the only moments worth
          // preserving — snapshotting on every apply would only ever archive
          // this tool's own previous output.
          const preexisting = output === undefined || olds === undefined;

          return yield* locks.withLock(
            address,
            Effect.gen(function* () {
              const observed = yield* reconciler.observe(news, ctx);
              const desired = yield* reconciler.desired(news);

              if (Option.isSome(observed) && reconciler.matches(observed.value, desired)) {
                return observed.value;
              }

              const snapshot =
                reconciler.snapshotBeforeApply && preexisting
                  ? yield* ctx.snapshot(address)
                  : undefined;

              return yield* reconciler.apply(
                { props: news, observed, desired, ...(snapshot === undefined ? {} : { snapshot }) },
                ctx,
              );
            }),
          );
        }),

        delete: Effect.fn(function* ({
          olds,
          output,
          session,
        }: {
          olds: Res["Props"];
          output: Res["Attributes"];
          session: ScopedPlanStatusSession;
        }) {
          // `None` (no `retain()`/`destroy()` in scope) reads as `"retain"`
          // here, not Alchemy's own `"destroy"` fallback — see this
          // function's doc comment for why the default is re-decided rather
          // than inherited.
          const policy = yield* Effect.serviceOption(RemovalPolicy).pipe(
            Effect.map(Option.getOrElse((): "retain" | "destroy" => "retain")),
          );
          const unapply = reconciler.unapply;
          if (policy !== "destroy" || !unapply) return;

          const address = reconciler.address(olds);
          const ctx = applyCtx(session);

          // Same mutual exclusion as `reconcile`: undoing is still a
          // read-modify-write against a shared address. `observed` is
          // re-read inside the lock rather than trusted from `output` alone,
          // so a resource hand-edited or already cleaned up between `deploy`
          // and `destroy` is undone from what is actually there — `output`
          // is passed through too, only as `recorded`, for a reconciler that
          // needs bookkeeping (like a captured backup path) that cannot be
          // re-derived by observation.
          yield* locks.withLock(
            address,
            Effect.gen(function* () {
              const observed = yield* reconciler.observe(olds, ctx);
              if (Option.isNone(observed)) return;
              yield* unapply({ props: olds, observed: observed.value, recorded: output }, ctx);
            }),
          );
        }),
      } satisfies Provider.ProviderServiceInput<Res>;
    }),
  );
