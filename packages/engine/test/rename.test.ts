import { expect, it } from "@effect/vitest";
import { RenamePolicy, renamedFrom } from "alchemy/Rename";
import * as Effect from "effect/Effect";

/**
 * `renamedFrom` lets a recipe rename a resource's *logical id* without the engine
 * planning a destroy and a create.
 *
 * This became load-bearing when `refuseUnowned` landed. Renaming
 * `Machine.File("old-id")` to `("new-id")` leaves the state row under the old id,
 * so the new one plans a create — and a create now *refuses*, because the file it
 * finds on disk is unowned. Before `refuseUnowned` the same rename silently
 * overwrote. Nothing in this repo mentioned `renamedFrom`, which is why it is
 * written down here.
 *
 *     yield* Dotfiles.File("new-id", { ... }).pipe(renamedFrom("old-id"));
 *
 * What this test covers is the boundary that is ours: that `renamedFrom` supplies
 * `RenamePolicy` with the former ids, which is the service `Resource` reads at
 * registration to populate `FormerFqns`. Migrating the state row from those is
 * Alchemy's own code (`Plan.js` walks `FormerFqns`), and constructing a real
 * resource to observe it requires a live `Stack` — so proving the migration
 * end to end belongs in the container check, not here. Recorded rather than
 * quietly skipped: docs/TASKS.md carries it as the remaining half.
 *
 * Both tests provide a deliberately wrong `RenamePolicy` underneath and assert
 * they see `renamedFrom`'s value instead. That is not belt-and-braces: upstream
 * types `renamedFrom` as `(effect: Effect<A, E, R>) => Effect<A, E, R>`, keeping
 * `R` unchanged even though it provides the service, so the requirement is not
 * discharged in the type. Providing a sentinel satisfies the compiler *and* makes
 * the assertion sharper — seeing the former ids proves the override happened
 * rather than merely that some policy was reachable.
 */
const SENTINEL: readonly string[] = ["never-read-this"];
it.effect("renamedFrom supplies the former ids as RenamePolicy", () =>
  Effect.gen(function* () {
    const policy = yield* RenamePolicy;
    expect([...policy]).toEqual(["old-id", "older-id"]);
  }).pipe(renamedFrom("old-id", "older-id"), Effect.provideService(RenamePolicy, SENTINEL)),
);

it.effect("an fqn-qualified former id is passed through unchanged", () =>
  Effect.gen(function* () {
    const policy = yield* RenamePolicy;
    expect([...policy]).toEqual([{ fqn: "LegacyStack/Assets" }]);
  }).pipe(
    renamedFrom({ fqn: "LegacyStack/Assets" }),
    Effect.provideService(RenamePolicy, SENTINEL),
  ),
);
