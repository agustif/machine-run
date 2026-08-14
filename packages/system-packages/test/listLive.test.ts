import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { CommandExecutor, CommandExecutorLive } from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { silentSession } from "@machine-run/core";
import { makePackageReconciler } from "../src/Package.ts";

/**
 * `list` against this machine's real package managers, through the real
 * `CommandExecutor`. Asserts only what is true of any machine: it completes,
 * and every entry names a manager and a package. Asserting a specific package
 * would pin the test to whatever happens to be installed here.
 */
/**
 * Opt-in, like `windowsLive.test.ts` and `IcaclsLive.test.ts`: it shells out to
 * every package manager on the host, which is slow and contends with the rest of
 * the suite — it passed alone and failed under full-suite load, which is exactly
 * the flakiness the `*Live` convention exists to keep out of the default run.
 *
 *     MACHINE_RUN_LIVE_PACKAGE_LIST=1 npx vitest run packages/system-packages/test/listLive.test.ts
 */
// Same shape `windowsLive.test.ts` uses for its own opt-in env vars.
const optedIn = Option.isSome(
  Effect.runSync(Config.option(Config.string("MACHINE_RUN_LIVE_PACKAGE_LIST"))),
);

it.effect.skipIf(!optedIn)("list enumerates real packages from whichever managers are present", () =>
  Effect.gen(function* () {
    const reconciler = yield* makePackageReconciler;
    const list = reconciler.list;
    if (list === undefined) return yield* Effect.die("expected list to be defined");

    const executor = yield* CommandExecutor;
    const entries = yield* list({
      exec: (props) => executor.run(props, silentSession),
      execution: { privilege: "none", locale: "C", defaultTimeout: "2 minutes" },
    });

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.manager).toBeTruthy();
      expect(entry.name).toBeTruthy();
    }
    const managers = [...new Set(entries.map((entry) => entry.manager))].sort();
    yield* Effect.log(`list found ${entries.length} packages across: ${managers.join(", ")}`);
  }).pipe(
    Effect.scoped,
    Effect.provide(CommandExecutorLive().pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);
