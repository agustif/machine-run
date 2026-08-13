import { Sh } from "@machine-run/core";
import type { Exec } from "@machine-run/engine";
import * as Boolean from "effect/Boolean";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ServiceParseError, type ServiceBackend, type ServiceObservation } from "../../Backend.ts";

/**
 * Homebrew's own `brew services`, which wraps `launchctl` on macOS and
 * `systemctl --user` on Linux (per `brew services --help`'s own banner:
 * "Manage background services with macOS' `launchctl`(1) daemon manager or
 * Linux's `systemctl`(1) service manager") — a formula-scoped abstraction
 * over the very two backends this package also implements directly. This
 * module is grouped under `backends/macos/` because that is where it was
 * implemented and verified in this repo, not because the underlying tool is
 * macOS-only; it should work unmodified on Linux once someone verifies that
 * path (see `docs/TASKS.md`).
 *
 * ## Verified directly, read-only, on this machine
 *
 * `brew services list --json` and `brew services info <formula> --json`
 * were both run for real against `transmission-cli` (a formula installed on
 * this machine with a service stanza, never started). Real captured output
 * of `brew services info transmission-cli --json`:
 *
 * ```json
 * [
 *   {
 *     "name": "transmission-cli",
 *     "running": false,
 *     "loaded": false,
 *     "pid": null,
 *     "user": null,
 *     "status": "none",
 *     "file": "/opt/homebrew/opt/transmission-cli/homebrew.mxcl.transmission-cli.plist",
 *     "registered": false,
 *     ...
 *   }
 * ]
 * ```
 *
 * `registered`/`loaded`/`running` map directly onto {@link ServiceObservation}'s
 * `installed`/`enabled`/`running` — confirmed against Homebrew's own source
 * (`Homebrew::Services::FormulaWrapper#to_hash` in this machine's
 * `/opt/homebrew/Library/Homebrew/services/formula_wrapper.rb`):
 * `registered: service_file_present?` (the plist exists at its destination),
 * `loaded: loaded?(cached: true)` (currently loaded into launchd/systemd),
 * `running: pid?`. This is independent confirmation that "installed vs.
 * enabled vs. running" is the right three-way cut, not an invention of this
 * package's own.
 *
 * ## What `converge` does, and why it isn't one command per flag
 *
 * `brew services` has exactly four verbs, each moving *both* axes at once —
 * confirmed by reading `services/cli.rb`'s `start`/`stop`/`kill`/`run`
 * directly, not guessed from `--help`:
 *
 * - `start`  → registers **and** starts: `(enabled: true, running: true)`.
 * - `stop`   → unregisters **and** stops: `(enabled: false, running: false)`.
 * - `kill`   → stops but *keeps* the registration — `Cli.kill` is a no-op
 *   printing "is not started" when nothing has a PID yet, so it can only
 *   ever move `running: true → false`, never register something fresh.
 * - `run`    → starts without registering, and is a no-op printing
 *   "already running" if a PID already exists — so it can only ever move
 *   `enabled: * , running: false → true`, never unregister something
 *   already running.
 *
 * Neither `kill` nor `run` alone can reach `(enabled: true, running: false)`
 * or `(enabled: false, running: true)` from a cold, never-registered state,
 * because both refuse to act on the axis they don't touch. So `converge`
 * reaches those two states with a two-command recipe instead — `start` then
 * `kill` for the former, `stop` then `run` for the latter — always issued in
 * that order regardless of the service's current state, the same
 * "always write the full desired state, never a minimal diff" choice
 * `system-settings`' `Setting.ts` makes for exactly this reason: a
 * deterministic recipe per target is far easier to reason about than one
 * that branches on every possible starting point. The one real cost: asking
 * for `(enabled: true, running: false)` from cold makes the service start
 * and then immediately stop again, which is observable (briefly) rather
 * than free — see `docs/TASKS.md`.
 */
const BrewServiceInfoEntry = Schema.Struct({
  registered: Schema.Boolean,
  loaded: Schema.Boolean,
  running: Schema.Boolean,
});

const BrewServiceInfoList = Schema.fromJsonString(Schema.Array(BrewServiceInfoEntry));
const decodeBrewServiceInfoList = Schema.decodeUnknownEffect(BrewServiceInfoList);

const parseFailure = (cause: unknown) => new ServiceParseError({ backend: "brew-services", cause });

const runStart = (name: string, exec: Exec) =>
  exec({ command: Sh.sh("brew", "services", "start", name), shell: true, timeout: "2 minutes" });

const runStop = (name: string, exec: Exec) =>
  exec({ command: Sh.sh("brew", "services", "stop", name), shell: true, timeout: "2 minutes" });

const runKill = (name: string, exec: Exec) =>
  exec({ command: Sh.sh("brew", "services", "kill", name), shell: true, timeout: "2 minutes" });

const runRun = (name: string, exec: Exec) =>
  exec({ command: Sh.sh("brew", "services", "run", name), shell: true, timeout: "2 minutes" });

export const makeBrewServicesBackend = (): ServiceBackend => {
  const observe: ServiceBackend["observe"] = (name, _path, exec) =>
    Effect.gen(function* () {
      const result = yield* exec({
        command: Sh.sh("brew", "services", "info", name, "--json"),
        shell: true,
      });
      const entries = yield* decodeBrewServiceInfoList(result.stdout).pipe(
        Effect.catchTag("SchemaError", (cause) => Effect.fail(parseFailure(cause))),
      );
      const entry = entries[0];
      if (entry === undefined) {
        return yield* Effect.fail(parseFailure(`no entry for "${name}" in brew services output`));
      }
      return {
        installed: entry.registered,
        enabled: entry.loaded,
        running: entry.running,
      } satisfies ServiceObservation;
    });

  const converge: ServiceBackend["converge"] = (name, _path, desired, exec) =>
    Boolean.match(desired.enabled, {
      onTrue: () =>
        Boolean.match(desired.running, {
          onTrue: () => runStart(name, exec).pipe(Effect.asVoid),
          onFalse: () =>
            Effect.gen(function* () {
              yield* runStart(name, exec);
              yield* runKill(name, exec);
            }),
        }),
      onFalse: () =>
        Boolean.match(desired.running, {
          onTrue: () =>
            Effect.gen(function* () {
              yield* runStop(name, exec);
              yield* runRun(name, exec);
            }),
          onFalse: () => runStop(name, exec).pipe(Effect.asVoid),
        }),
    });

  return { id: "brew-services", observe, converge };
};
