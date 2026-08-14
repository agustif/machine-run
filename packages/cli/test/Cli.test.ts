import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";
import { machineRun } from "../src/Cli.ts";
import { ConfirmationRequired } from "../src/Commands.ts";

/**
 * `deploy`/`destroy` are registered as real subcommands, not just functions
 * in `Commands.ts` — this runs the actual CLI parser to prove it.
 *
 * Neither invocation below passes `--yes`, so both refuse via
 * `ConfirmationRequired` before touching anything (see `Commands.test.ts` for
 * that refusal itself). That refusal is what this test uses as its signal: a
 * *recognized* subcommand parses successfully and reaches its own handler,
 * which then fails with `ConfirmationRequired`. An unrecognized name never
 * reaches a handler at all, so it fails a different way — which the third
 * test below confirms, to show the first two aren't trivially true.
 */
const runMachineRun = Command.runWith(machineRun, { version: "0.0.0" });

it.effect("deploy is registered: parsing succeeds and its handler runs", () =>
  Effect.gen(function* () {
    const error = yield* runMachineRun(["deploy"]).pipe(Effect.flip);
    expect(error).toBeInstanceOf(ConfirmationRequired);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("destroy is registered: parsing succeeds and its handler runs", () =>
  Effect.gen(function* () {
    const error = yield* runMachineRun(["destroy"]).pipe(Effect.flip);
    expect(error).toBeInstanceOf(ConfirmationRequired);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("an unregistered name fails before reaching any handler", () =>
  Effect.gen(function* () {
    const error = yield* runMachineRun(["not-a-real-subcommand"]).pipe(Effect.flip);
    expect(error).not.toBeInstanceOf(ConfirmationRequired);
  }).pipe(Effect.provide(NodeServices.layer)),
);
