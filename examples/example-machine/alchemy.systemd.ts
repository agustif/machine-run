/**
 * `System.Service` alone, against a real `systemd --user` instance.
 *
 * Separate from `alchemy.container.ts` because the requirement is not a package
 * but a booted init system: `systemctl --user` refuses without the *system*
 * instance too (`sd_booted()` checks for it), so this needs a privileged
 * container with systemd as PID 1 and `/sys/fs/cgroup` mounted. Folding that into
 * the main check would mean making its image privileged and systemd-based, which
 * is a large change to a check that currently passes 53 assertions unprivileged —
 * a bad trade for one resource kind.
 *
 * `backends/linux/SystemdUser.ts`'s doc comment records the exact container setup
 * and the exact command outputs this exercises; `scripts/deploy-check-systemd.sh`
 * is that setup, automated.
 */
import * as Core from "@machine-run/core";
import * as SystemServices from "@machine-run/system-services";
import * as Alchemy from "alchemy";
import { CommandExecutorLive } from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const providers = SystemServices.providers().pipe(
  Layer.provideMerge(Core.services()),
  Layer.provide(CommandExecutorLive()),
);

export default Alchemy.Stack(
  "example-machine-systemd",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    // The unit file is written by `entrypoint.sh` before this runs —
    // `System.Service` reconciles a unit's *enabled/running* state and
    // deliberately does not author unit files, so the recipe cannot create it.
    yield* SystemServices.Service("demo-systemd-unit", {
      backend: "systemd-user",
      name: "mrtest.service",
      enabled: true,
      running: true,
    });
  }),
);
