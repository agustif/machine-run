import { MachinePaths } from "@machine-run/core";
import { type ObserveContext, type Reconciler, toProvider } from "@machine-run/engine";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { makeBrewServicesBackend } from "./backends/macos/BrewServices.ts";
import { makeLaunchdBackend } from "./backends/macos/Launchd.ts";
import { makeSystemdUserBackend } from "./backends/linux/SystemdUser.ts";
import { type ServiceBackend, ServiceBackendId, type ServiceBackendError } from "./Backend.ts";

/**
 * One user-level background service, tracked as **three separate facts**
 * rather than one status:
 *
 * - **installed** — the service's definition (a plist, a unit file, a
 *   formula's service stanza) exists where the manager looks for it.
 * - **enabled** — the manager will act on it without further action next
 *   time it has the chance to (`launchd`'s "loaded", `systemd`'s "enabled",
 *   Homebrew's "loaded").
 * - **running** — it has a live instance right now.
 *
 * ## Why this is not one status enum
 *
 * `@machine-run/runtimes`' `Runtime.Tool` had to learn this exact lesson for
 * "installed" vs. "active": collapsing two independent facts into one
 * reading makes "installed but not active" and "active but not installed" —
 * both real, observed states there — indistinguishable from either
 * "converged" or "absent". The same collapse would be worse here, because a
 * *third* independent axis is real and commonly reached on purpose, not just
 * as a transient or drifted state:
 *
 * - `enabled: true, running: false` — Homebrew's own `kill` verb exists
 *   *specifically* to reach this ("stop the service immediately but keep it
 *   registered to launch at login").
 * - `enabled: false, running: true` — Homebrew's own `run` verb exists
 *   *specifically* to reach this ("run the service formula without
 *   registering to launch at login"), and it was captured live for
 *   `systemd-user` too: starting a never-enabled unit and then re-checking
 *   `is-enabled` printed `disabled` while the unit was genuinely `active` —
 *   see `backends/linux/SystemdUser.ts`'s doc comment for the exact
 *   transcript.
 *
 * Two widely-used, independently-designed tools each drew the same
 * enabled/running distinction on purpose. Folding it back into one boolean
 * here would throw away a distinction the underlying tools already consider
 * load-bearing, not simplify an accidental one.
 *
 * `installed` is reported but deliberately **not** part of what a recipe
 * declares or what `matches` compares — see {@link makeServiceReconciler}'s
 * `desired`/`matches` for why.
 *
 * ## Scope: user-level only
 *
 * `launchd`'s system domain, plain `systemctl` (no `--user`) and
 * `sudo brew services` all manage services that start before login and run
 * as root — a different privilege boundary this resource does not cross.
 * See `Backend.ts`'s doc comment and `docs/TASKS.md`.
 */
export const ServiceProps = Schema.Struct({
  /** Which service manager to reconcile against. */
  backend: ServiceBackendId,
  /**
   * The service's identifier in the backend's own namespace: a launchd
   * label (`"com.example.myagent"`), a systemd unit name including its
   * suffix (`"myagent.service"`), or a Homebrew formula name
   * (`"transmission-cli"`).
   */
  name: Schema.String,
  /**
   * `launchd` only: the absolute path of the plist to load/unload when the
   * job is not already loaded. Defaults to the conventional
   * `~/Library/LaunchAgents/<name>.plist` — see `backends/macos/Launchd.ts`
   * for the real, observed example this convention is drawn from. Ignored
   * by `systemd-user` (unit files are found by name in the standard search
   * path) and `brew-services` (the formula's own plist/unit is resolved
   * automatically by `brew services`).
   */
  path: Schema.optionalKey(Schema.String),
  /** Whether the service should be enabled. @default true */
  enabled: Schema.optionalKey(Schema.Boolean),
  /** Whether the service should be running right now. @default true */
  running: Schema.optionalKey(Schema.Boolean),
});

export type ServiceProps = typeof ServiceProps.Type;

export const ServiceState = Schema.Struct({
  backend: ServiceBackendId,
  name: Schema.String,
  installed: Schema.Boolean,
  enabled: Schema.Boolean,
  running: Schema.Boolean,
});

export type ServiceState = typeof ServiceState.Type;

export interface Service extends Resource<"System.Service", ServiceProps, ServiceState> {}

export const Service = Resource<Service>("System.Service");

/**
 * `converge` ran without error, but a fresh observation immediately
 * afterwards still doesn't show the requested `enabled`/`running` pair.
 *
 * Mirrors `runtimes`' `RuntimeNotConverged` and `system-settings`'
 * `SettingWriteNotObserved`: a manager reporting success while leaving the
 * machine in a state its own read path disagrees with is surfaced rather
 * than silently retried or trusted, per `AGENTS.md` rule 11.
 */
export class ServiceNotConverged extends Data.TaggedError("ServiceNotConverged")<{
  backend: ServiceBackendId;
  name: string;
  expectedEnabled: boolean;
  expectedRunning: boolean;
  actualEnabled: boolean;
  actualRunning: boolean;
}> {
  override get message() {
    return (
      `${this.backend} reported "${this.name}" converged, but a fresh observation shows ` +
      `enabled=${this.actualEnabled}, running=${this.actualRunning} instead of the requested ` +
      `enabled=${this.expectedEnabled}, running=${this.expectedRunning}.`
    );
  }
}

/**
 * The provider body, exported separately from `ServiceProvider` so a test
 * can build it directly and drive `observe`/`matches`/`apply` without the
 * alchemy engine or a real `CommandExecutor` — see
 * `packages/dotfiles/src/File.ts` for the same pattern.
 *
 * Backends are built inline here, not through a separate `Store.ts`, because
 * `launchd` genuinely needs constructor dependencies (`MachinePaths`,
 * `FileSystem`, `Path` — to resolve and check the conventional plist path)
 * the same way `runtimes`' backends do; `system-settings`' `Store.ts` works
 * precisely because none of *its* backends need anything beyond an `Exec`.
 */
export const makeServiceReconciler: Effect.Effect<
  Reconciler<ServiceProps, ServiceState, ServiceBackendError | ServiceNotConverged>,
  never,
  MachinePaths | FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const paths = yield* MachinePaths;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  const backends = {
    launchd: makeLaunchdBackend({ home: paths.home, path, fs }),
    "systemd-user": makeSystemdUserBackend(),
    "brew-services": makeBrewServicesBackend(),
  } satisfies Record<ServiceBackendId, ServiceBackend>;

  // Never returns `undefined`: unlike `System.Package`'s membership
  // question, "nothing here" is itself a meaningful, fully-expressible
  // `ServiceState` (`installed: false, enabled: false, running: false`),
  // not an absence `Reconciler.observe` has to signal separately.
  const observe = (props: ServiceProps, ctx: ObserveContext) =>
    Effect.gen(function* () {
      const backend = backends[props.backend];
      const observation = yield* backend.observe(props.name, props.path, ctx.exec);
      return {
        backend: props.backend,
        name: props.name,
        ...observation,
      };
    });

  return {
    // Two `System.Service`s naming the same (backend, service) contend for
    // the same real thing and serialise; two different services — even on
    // the same backend — reconcile independently, since neither `launchctl`
    // nor `systemctl --user` nor `brew services` holds one shared lock the
    // way `dpkg` does for every package (`System.Package`'s reason for
    // addressing by manager alone does not apply here).
    address: (props) => `${props.backend}:${props.name}`,

    observe,

    // `installed` is always requested as `true`. It is not an independent
    // dial a recipe can turn: enabling or running a service is only
    // possible when a definition already exists somewhere this resource
    // does not author (a plist written by `Machine.File`, a unit shipped by
    // a package, a formula's own service stanza) — this resource converges
    // `enabled`/`running` against whatever backend it's given, and never
    // creates or deletes the definition itself, mirroring `AGENTS.md` rule
    // 10 (`delete` never reverses what created it). Setting it to anything
    // else here would invent a request `apply` has no way to honestly act
    // on.
    desired: (props) =>
      Effect.succeed({
        backend: props.backend,
        name: props.name,
        installed: true,
        enabled: props.enabled ?? true,
        running: props.running ?? true,
      }),

    // `installed` is deliberately excluded. A fully "off" request
    // (`enabled: false, running: false`) is satisfied whether or not the
    // definition file still exists — removing it is a different resource's
    // job, never this one's — and a request that *does* need it present
    // (`enabled: true` or `running: true`) cannot be satisfied by comparing
    // a boolean anyway: if the definition is genuinely missing, `apply`
    // fails loudly with the backend's own `CommandError` (no path known to
    // load, no unit file to enable, no formula stanza to start) rather than
    // reporting a mismatch that would replan forever with no path to
    // convergence.
    matches: (observed, desired) =>
      observed.backend === desired.backend &&
      observed.name === desired.name &&
      observed.enabled === desired.enabled &&
      observed.running === desired.running,

    apply: ({ props, desired }, ctx) =>
      Effect.gen(function* () {
        const backend = backends[props.backend];
        yield* backend.converge(
          props.name,
          props.path,
          { enabled: desired.enabled, running: desired.running },
          ctx.exec,
        );

        // Re-observed rather than trusted, the same read-after-write
        // confirmation `system-settings`' `Setting.ts` and `runtimes`'
        // `Tool.ts` both use — a service manager silently no-oping is a
        // real, precedented failure mode for exactly this kind of command
        // (`gsettings set`'s container-verified silent no-op is the model
        // case), not a hypothetical this resource is inventing a check for.
        const reobserved = yield* backend.observe(props.name, props.path, ctx.exec);
        if (
          reobserved.enabled !== desired.enabled ||
          reobserved.running !== desired.running
        ) {
          return yield* Effect.fail(
            new ServiceNotConverged({
              backend: props.backend,
              name: props.name,
              expectedEnabled: desired.enabled,
              expectedRunning: desired.running,
              actualEnabled: reobserved.enabled,
              actualRunning: reobserved.running,
            }),
          );
        }

        return { backend: props.backend, name: props.name, ...reobserved };
      }),
  };
});

export const ServiceProvider = () => toProvider(Service, makeServiceReconciler);
