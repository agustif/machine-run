import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";
import { machineRun } from "./Cli.ts";

// The command tree lives in `Cli.ts` so it can be imported for tests without
// this running `Command.run` against the test process's own argv.
machineRun.pipe(
  Command.run({ version: "0.0.0" }),
  Effect.provide(NodeServices.layer),
  // The command handler already renders every outcome via `describeExit`, so
  // the default runner's own error logging would only repeat it.
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
