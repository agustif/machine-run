/**
 * `MacOS.Default` alone, on a real macOS.
 *
 * The one resource kind no Linux container can exercise: it drives `defaults`
 * and `plutil`. `scripts/deploy-check-macos.sh` runs this directly on the host
 * rather than in a container, which is also why the domain below is namespaced to
 * this tool and deleted afterwards — the "machine" being reconciled is whatever
 * Mac invoked the script, including a developer's own.
 */
import * as Core from "@machine-run/core";
import * as MacOsDefaults from "@machine-run/macos-defaults";
import * as Alchemy from "alchemy";
import { CommandExecutorLive } from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const providers = MacOsDefaults.providers().pipe(
  Layer.provideMerge(Core.services()),
  Layer.provide(CommandExecutorLive()),
);

export default Alchemy.Stack(
  "example-machine-macos",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    // A domain no real application owns, so a failed run cannot leave a user's
    // own preferences altered. `restartApp` is deliberately unset: there is no
    // app to restart, and `killall` on a shared runner is not something a check
    // should do.
    yield* MacOsDefaults.MacDefault("demo-macos-default", {
      domain: "com.machine-run.deploycheck",
      key: "sampleKey",
      value: "expected",
    });
  }),
);
