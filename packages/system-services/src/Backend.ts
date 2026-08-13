import type { CommandError } from "alchemy/Command";
import type { Exec } from "@machine-run/engine";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";

/**
 * Every user-level service manager this repo knows how to reconcile against.
 *
 * Deliberately **user-level only**. `launchctl`'s system domain, `systemctl`
 * (no `--user`) and `sudo brew services` all manage services that start
 * before any user logs in and run as root — a different privilege boundary
 * and a different failure mode (a bad system daemon can make a machine fail
 * to boot; a bad user agent just fails to start for one person). Covering
 * that surface is `docs/TASKS.md`'s job, not a fourth id squeezed in here.
 */
export const ServiceBackendId = Schema.Literals(["launchd", "systemd-user", "brew-services"]);

export type ServiceBackendId = typeof ServiceBackendId.Type;

export class ServiceParseError extends Data.TaggedError("ServiceParseError")<{
  backend: ServiceBackendId;
  cause: unknown;
}> {
  override get message() {
    return `Could not parse ${this.backend}'s output. This usually means the CLI's output format changed, or it printed a warning where machine-run expected only data.`;
  }
}

/**
 * `PlatformError` joins the union for exactly one backend (`launchd`, which
 * checks a plist's existence with `FileSystem` rather than shelling out to
 * `test -e` — see `backends/macos/Launchd.ts`'s doc comment). The other two
 * backends never produce one; the type is shared so `System.Service`'s
 * reconciler has one error channel for every backend rather than a
 * per-manager union computed from whichever happens to be wired in — the
 * same shape `runtimes`' `BackendError` uses for the identical reason.
 */
export type ServiceBackendError = CommandError | ServiceParseError | PlatformError;

/**
 * What one backend reports about one service, right now.
 *
 * Three independent facts, not one status enum — this is the whole point of
 * the resource this seam backs. See `Service.ts`'s doc comment for the full
 * reasoning; in short, `@machine-run/runtimes`' `Runtime.Tool` already had to
 * learn this lesson for "installed" vs "active", and Homebrew's own
 * `services.rb` independently arrived at the identical three-way split
 * (`registered`/`loaded`/`running` in its own `to_hash` — verified by reading
 * `Homebrew::Services::FormulaWrapper#to_hash` directly, in this machine's
 * own `/opt/homebrew/Library/Homebrew/services/formula_wrapper.rb`), which is
 * strong independent confirmation this is the right cut rather than an
 * invented one.
 */
export interface ServiceObservation {
  /** The service definition (a plist, a unit file, a formula's own service stanza) exists where the manager looks for it. */
  readonly installed: boolean;
  /**
   * The manager will act on this service without further action next time
   * it has the chance to — `launchd` calls this "loaded", `systemd` calls it
   * "enabled", Homebrew calls it "loaded". None of the three back a true
   * persistent "will this survive a reboot" guarantee the way, say, a
   * `WantedBy=` symlink's mere *existence* does; see `backends/macos/Launchd.ts`
   * for exactly what this does and does not capture for launchd.
   */
  readonly enabled: boolean;
  /** The service has a live, running instance right now. */
  readonly running: boolean;
}

/**
 * The shared shape every user-level service manager backend implements —
 * `System.Service`'s one atomic seam, the same pattern as `system-packages`'
 * `PackageManagerBackend` and `runtimes`' `RuntimeBackend`. `System.Service`
 * knows nothing about `launchctl`/`systemctl`/`brew services` specifically;
 * it calls whichever backend's `observe`/`converge` the caller selected.
 * Adding a manager means writing one small backend module, never touching
 * the resource itself.
 *
 * Every method takes an {@link Exec} — the reconciler's own command-running
 * capability, already bound to whichever session belongs to the current
 * phase. A backend never sees a session or a `CommandExecutor` directly, and
 * so cannot run a command outside the reconciler's own bookkeeping.
 *
 * `path` is opaque and backend-specific, the same way `PackageManagerBackend`
 * leaves a package's `name` opaque to its own manager's namespace. Only
 * `launchd` consults it (the absolute path of the plist to load/unload when
 * the job is not already loaded — see `ServiceProps.path`'s doc comment in
 * `Service.ts`); `systemd-user` and `brew-services` both resolve their own
 * unit/formula from `name` alone and ignore it.
 */
export interface ServiceBackend {
  readonly id: ServiceBackendId;

  readonly observe: (
    name: string,
    path: string | undefined,
    exec: Exec,
  ) => Effect.Effect<ServiceObservation, ServiceBackendError>;

  /**
   * Converges `enabled` and `running` to exactly the values given.
   *
   * Deliberately one method taking both flags, not two independent
   * `setEnabled`/`setRunning` calls: `launchd` and `systemd-user` genuinely
   * do have two independent primitives (load/unload, enable/disable vs.
   * start/stop) and could honor a split call, but Homebrew's four
   * subcommands (`start`/`stop`/`kill`/`run` — see `backends/macos/BrewServices.ts`)
   * each move *both* axes as one atomic operation, so there is no
   * `brew services` call that means "just flip `enabled`, leave `running`
   * exactly as it is." Giving every backend the full desired pair up front,
   * rather than two calls it would have to reconstruct the other half of
   * from nowhere, is the shape that is honest for all three.
   */
  readonly converge: (
    name: string,
    path: string | undefined,
    desired: { readonly enabled: boolean; readonly running: boolean },
    exec: Exec,
  ) => Effect.Effect<void, ServiceBackendError>;
}
