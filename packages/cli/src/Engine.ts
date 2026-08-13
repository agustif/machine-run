import { NodeServices } from "@effect/platform-node";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { LoggingCli } from "alchemy/Cli/LoggingCli";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * The services a stack needs supplied from outside `Stack.evalStack`.
 *
 * `evalStack` wires its own platform layer as
 * `Layer.provideMerge(alchemy(dev), platform)` — that is, it provides
 * `platform` *to* the layer that produces `AlchemyContext`. But `platform`
 * itself contains `Logger.layer([fileLogger("out")])`, and `fileLogger` opens
 * with `yield* AlchemyContext` to find the `.alchemy` directory to log into.
 * So the platform layer requires a service that is only created above it, and
 * `AlchemyContextLive` in turn requires the `FileSystem` and `Path` that
 * platform supplies. Building the stack therefore dies with
 * `Service not found: alchemy/Context` before a single resource is looked at —
 * which is why this reproduces identically for a stack with no resources, no
 * providers and no machine-run import at all.
 *
 * Supplying both from outside satisfies the requirement without touching
 * Alchemy's own wiring, which stays a dependency rather than a fork.
 * `AlchemyContextLive` is built here from `NodeServices` alone, so nothing that
 * needs `AlchemyContext` sits underneath it.
 */
export const stackServices = Layer.mergeAll(
  NodeServices.layer,
  Layer.provide(AlchemyContextLive, NodeServices.layer),
  // `Apply.apply` and `Plan.make` resolve `Cli` for progress reporting.
  // Alchemy's own non-TUI implementation is used rather than a bespoke one:
  // the plan's shape is Alchemy's to describe, and a second renderer would
  // drift from it silently. It is also the option that avoids the Ink TUI,
  // which is a plausible home for the undiagnosed half of the plan failure.
  LoggingCli,
);

/**
 * Supplies {@link stackServices} to a program that drives a stack.
 *
 * Kept as one function rather than inlined at each command so the ordering
 * above is stated once. Getting it wrong is not a compile error — it is a
 * runtime death with a message that names a service nobody wrote.
 */
export const withStackServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(stackServices), Effect.scoped);
