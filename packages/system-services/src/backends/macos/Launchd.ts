import { Sh } from "@machine-run/core";
import type { Exec } from "@machine-run/engine";
import * as Boolean from "effect/Boolean";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import type * as Path from "effect/Path";
import type { ServiceBackend, ServiceBackendError, ServiceObservation } from "../../Backend.ts";

/**
 * macOS's `launchd`, in the caller's own user domain, via `launchctl`'s
 * **legacy** subcommands (`load`/`unload`/`start`/`stop`/`list`) rather than
 * the modern `bootstrap`/`bootout`/`enable`/`disable`/`kickstart`/`print`
 * family.
 *
 * That choice is deliberate, not nostalgia: the modern subcommands address a
 * specific domain (`gui/<uid>/<label>`), which this backend would have to
 * compute a UID to build, while every legacy subcommand targets "the
 * caller's own domain" implicitly — the exact scope this backend already
 * commits to (user-level services only, see `Backend.ts`'s doc comment).
 * `man launchctl` documents `load`/`unload`/`start`/`stop` as having
 * "Recommended alternative subcommands" but does not say they are removed,
 * and — this matters more — it says of `print` specifically: **"This output
 * is NOT API in any sense at all. Do NOT rely on the structure or
 * information emitted for ANY reason. It may change from release to release
 * without warning."** `list`'s three-column and per-label formats carry no
 * such disclaimer. Given a choice between a documented-unstable modern
 * format and a documented-stable legacy one, this backend takes the stable
 * one. Verified directly on this machine (`man launchctl`, macOS Tahoe):
 * every command below was actually run, read-only, against real jobs —
 * never a mutating one, since this session must not change anything on the
 * user's real machine.
 *
 * ## What `enabled` does and does not mean here
 *
 * `enabled` reports whether `launchctl list <label>` finds the job — i.e.
 * whether it is currently loaded into launchd. This is **not** the same as
 * launchd's own persistent enable/disable override (`launchctl
 * enable`/`disable`, inspectable with `launchctl print-disabled`), which
 * survives across `unload`/reboot and gates whether a future `load` is even
 * allowed to succeed. Real captured example from this machine —
 * `launchctl print-disabled gui/501` lists
 * `"com.apple.appleseed.seedusaged.postinstall" => disabled` — a job that
 * could carry that override while this backend has never touched it and
 * never will; see `docs/TASKS.md` for that gap. "Loaded right now" is the
 * closest honest analogue to "enabled at boot" a legacy-subcommand backend
 * can report without adopting the modern domain-addressed API, and it is
 * what Homebrew's own `services.rb` calls "loaded" too (see `Backend.ts`'s
 * doc comment) — not a decision unique to this backend.
 *
 * ## `installed`
 *
 * Whether a plist exists at `path` (or, if unset, at the conventional
 * `~/Library/LaunchAgents/<name>.plist`). Checked with `FileSystem` rather
 * than a shelled-out `test -e`, the same way `runtimes`' `Uv.ts` backend
 * reads its pin file directly instead of shelling out to `cat`. The
 * label-equals-filename convention this default relies on is real, not
 * invented: this machine's own `~/Library/LaunchAgents/com.google.GoogleUpdater.wake.plist`
 * is loaded under the label `com.google.GoogleUpdater.wake`, confirmed with
 * `launchctl print gui/501/com.google.GoogleUpdater.wake` printing
 * `path = /Users/a/Library/LaunchAgents/com.google.GoogleUpdater.wake.plist`.
 *
 * ## `launchctl list <label>`'s shape
 *
 * Real, captured output for a running job (`launchctl list com.apple.Finder`):
 *
 * ```
 * {
 * 	"LimitLoadToSessionType" = "Aqua";
 * 	"Label" = "com.apple.Finder";
 * 	"OnDemand" = true;
 * 	"LastExitStatus" = 15;
 * 	"PID" = 31259;
 * 	"Program" = "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder";
 * };
 * ```
 *
 * and for a loaded-but-not-running job (`launchctl list com.apple.progressd`)
 * the `"PID"` key is **absent entirely** — never present-with-a-placeholder —
 * which is what {@link isRunning} keys off. A label launchd doesn't know
 * about at all (`launchctl list com.google.keystone.agent`, real output)
 * exits `113` with `Could not find service "com.google.keystone.agent" in
 * domain for port` on stderr — an ordinary "not loaded" reading, the same
 * collapse `system-settings`' backends make for a missing key, not a
 * failure to propagate.
 *
 * ## The one state launchd genuinely cannot occupy
 *
 * `enabled: false, running: true` is not reachable for launchd: nothing can
 * be running under launchd's supervision without also being loaded. Asking
 * for it here surfaces whichever real `launchctl` command fails first as an
 * honest `CommandError`, rather than this backend silently reordering
 * operations to fake the combination — see `docs/TASKS.md`.
 */
export const makeLaunchdBackend = (deps: {
  home: string;
  path: Path.Path;
  fs: FileSystem.FileSystem;
}): ServiceBackend => {
  const { home, path, fs } = deps;

  const resolvePath = (name: string, explicitPath: string | undefined): string =>
    explicitPath ?? path.join(home, "Library", "LaunchAgents", `${name}.plist`);

  /** Real captured shape: the `"PID" = <number>;` line is present only while running — see this module's doc comment. */
  const isRunning = (listOutput: string): boolean => /^\s*"PID"\s*=/m.test(listOutput);

  const observeLoaded = (
    name: string,
    exec: Exec,
  ): Effect.Effect<{ enabled: boolean; running: boolean }, ServiceBackendError> =>
    exec({ command: Sh.sh("launchctl", "list", name), shell: true }).pipe(
      Effect.map((result) => ({ enabled: true, running: isRunning(result.stdout) })),
      // A non-zero exit means launchd has never heard of this label — real
      // captured shape: exit 113, "Could not find service ... in domain for
      // port" on stderr. An ordinary "not loaded" state, not a failure.
      Effect.catch((error) =>
        Match.value(error.reason._tag).pipe(
          Match.when("UnexpectedExit", () => Effect.succeed({ enabled: false, running: false })),
          Match.orElse(() => Effect.fail(error)),
        ),
      ),
    );

  const observe: ServiceBackend["observe"] = (name, explicitPath, exec) =>
    Effect.gen(function* () {
      const resolved = resolvePath(name, explicitPath);
      const installed = yield* fs.exists(resolved);
      const loaded = yield* observeLoaded(name, exec);
      return { installed, ...loaded } satisfies ServiceObservation;
    });

  const setLoaded = (name: string, explicitPath: string | undefined, enabled: boolean, exec: Exec) =>
    Boolean.match(enabled, {
      onTrue: () =>
        exec({
          command: Sh.sh("launchctl", "load", resolvePath(name, explicitPath)),
          shell: true,
        }),
      onFalse: () =>
        exec({
          command: Sh.sh("launchctl", "unload", resolvePath(name, explicitPath)),
          shell: true,
        }),
    }).pipe(Effect.asVoid);

  const setRunning = (name: string, running: boolean, exec: Exec) =>
    Boolean.match(running, {
      onTrue: () => exec({ command: Sh.sh("launchctl", "start", name), shell: true }),
      onFalse: () => exec({ command: Sh.sh("launchctl", "stop", name), shell: true }),
    }).pipe(Effect.asVoid);

  const converge: ServiceBackend["converge"] = (name, explicitPath, desired, exec) =>
    Effect.gen(function* () {
      yield* setLoaded(name, explicitPath, desired.enabled, exec);
      yield* setRunning(name, desired.running, exec);
    });

  return { id: "launchd", observe, converge };
};
