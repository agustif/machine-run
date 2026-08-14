import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { services as coreServices } from "@machine-run/core";
import { CommandExecutor } from "alchemy/Command";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { PlatformError } from "effect/PlatformError";
import { type Reconciler, toProvider } from "../src/index.ts";

/**
 * Proves Alchemy's resource-type rename path works through `toProvider`,
 * because a release-blocking assumption depended on it being absent.
 *
 * The pending naming rename (nine namespaces, twenty-three kinds) was recorded
 * as a state-schema break that had to land before any real deploy, on the
 * reasoning that a state row persisted under `Machine.File` would find no
 * provider once the type became something else. Alchemy already solves this:
 * `Resource`'s second options argument takes `aliases`, `Provider.succeed`/
 * `.effect` copy them off the class onto the provider service, and
 * `tryFindProviderByType` falls back to scanning `aliases` when no provider is
 * keyed under the requested type.
 *
 * `toProvider` needs no change for this — it builds through `Provider.effect`,
 * which does the copying itself — and that is exactly why it deserves a test
 * rather than a comment: nothing in our own code mentions aliases, so the
 * whole mechanism is load-bearing behaviour we neither wrote nor control, and
 * a future Alchemy bump could remove it without anything here noticing.
 */
interface TestAliasedProps {
  readonly path: string;
}

interface TestAliasedState {
  readonly path: string;
}

interface TestAliased
  extends Resource<"Test.Engine.Renamed", TestAliasedProps, TestAliasedState> {}

/** The rename this simulates: `Test.Engine.Original` became
 * `Test.Engine.Renamed`, and old state rows still say the former. */
const TestAliased = Resource<TestAliased>("Test.Engine.Renamed", {
  aliases: ["Test.Engine.Original"],
});

/** Stub: this reconciler never calls `ctx.exec`, and no apply ever runs here
 * — the whole test is provider *lookup*. */
const supportLayers = Layer.mergeAll(
  Layer.succeed(CommandExecutor, {
    spawn: () => Effect.die("not used by this test"),
    run: () => Effect.die("not used by this test"),
  }),
  coreServices(),
).pipe(Layer.provideMerge(NodeServices.layer));

const reconciler: Effect.Effect<
  Reconciler<TestAliasedProps, TestAliasedState, PlatformError>,
  never,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  yield* FileSystem.FileSystem;
  return {
    address: (props) => props.path,
    observe: () => Effect.succeed(undefined),
    desired: (props) => Effect.succeed({ path: props.path }),
    matches: (observed, desired) => observed.path === desired.path,
    apply: ({ desired }) => Effect.succeed(desired),
  };
});

it.effect("a state row persisted under a pre-rename type still resolves to its provider", () =>
  Effect.gen(function* () {
    const found = yield* Provider.tryFindProviderByType("Test.Engine.Original");

    // The point of the test: the lookup is by the *old* name, and nothing is
    // registered under it — only the alias connects the two.
    expect(Option.isSome(found)).toBe(true);
  }).pipe(
    Effect.provide(toProvider(TestAliased, reconciler)),
    Effect.provide(supportLayers),
  ),
);

it.effect("the current type name resolves too, and to the same provider", () =>
  Effect.gen(function* () {
    const viaAlias = yield* Provider.tryFindProviderByType("Test.Engine.Original");
    const viaCurrent = yield* Provider.tryFindProviderByType("Test.Engine.Renamed");

    expect(Option.isSome(viaCurrent)).toBe(true);
    // Same service instance, not merely two resolutions that both succeeded —
    // an alias that resolved to some *other* provider would be worse than one
    // that failed to resolve at all.
    expect(Option.getOrThrow(viaAlias)).toBe(Option.getOrThrow(viaCurrent));
  }).pipe(
    Effect.provide(toProvider(TestAliased, reconciler)),
    Effect.provide(supportLayers),
  ),
);

it.effect("a type nobody claims, by name or alias, resolves to nothing", () =>
  Effect.gen(function* () {
    const found = yield* Provider.tryFindProviderByType("Test.Engine.NeverExisted");
    expect(Option.isNone(found)).toBe(true);
  }).pipe(
    Effect.provide(toProvider(TestAliased, reconciler)),
    Effect.provide(supportLayers),
  ),
);
