import type { CommandError } from "alchemy/Command";
import { MachinePathsLive } from "@machine-run/core";
import { NodeServices } from "@effect/platform-node";
import type { Exec } from "@machine-run/engine";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { makeBrewServicesBackend } from "../src/backends/macos/BrewServices.ts";
import { makeLaunchdBackend } from "../src/backends/macos/Launchd.ts";
import { makeSystemdUserBackend } from "../src/backends/linux/SystemdUser.ts";

const layer = MachinePathsLive().pipe(Layer.provideMerge(NodeServices.layer));

/** A command runner returning fixed output for every call. */
const fakeExec =
  (stdout: string): Exec =>
  () =>
    Effect.succeed({ exitCode: 0, stdout, stderr: "" });

/** A command that fails the way a real non-zero exit does. */
const failingExec =
  (exitCode: number, stderr: string): Exec =>
  (props) =>
    Effect.fail({
      _tag: "CommandError" as const,
      command: props.command,
      reason: { _tag: "UnexpectedExit" as const, exitCode, stderr, message: stderr },
      message: `Failed to execute command "${props.command}": ${stderr}`,
    } as CommandError);

/** A queued `Exec` fake and the commands it was actually asked to run. */
interface QueuedExec {
  readonly exec: Exec;
  readonly calls: string[];
}

/** Queues one outcome per call, in order. */
const queuedExec = (
  outcomes: ReadonlyArray<{ stdout: string } | { exitCode: number; stderr: string }>,
): QueuedExec => {
  const calls: string[] = [];
  let i = 0;
  const exec: Exec = (props) => {
    calls.push(props.command);
    const outcome = outcomes[i] ?? { stdout: "" };
    i += 1;
    if ("exitCode" in outcome) {
      return Effect.fail({
        _tag: "CommandError" as const,
        command: props.command,
        reason: {
          _tag: "UnexpectedExit" as const,
          exitCode: outcome.exitCode,
          stderr: outcome.stderr,
          message: outcome.stderr,
        },
        message: `Failed to execute command "${props.command}": ${outcome.stderr}`,
      } as CommandError);
    }
    return Effect.succeed({ exitCode: 0, stdout: outcome.stdout, stderr: "" });
  };
  return { exec, calls };
};

// ---------------------------------------------------------------------------
// backends/macos/Launchd.ts
//
// Every string below is real, captured output from this machine (macOS
// Tahoe) — `launchctl list <label>` and `launchctl list <nonexistent-label>`,
// read-only, never a mutating command. See `Launchd.ts`'s doc comment for
// how the plist-path convention was independently confirmed too.
// ---------------------------------------------------------------------------

/** Real captured `launchctl list com.apple.Finder` — a running job. */
const LAUNCHCTL_LIST_RUNNING = `{
	"LimitLoadToSessionType" = "Aqua";
	"MachServices" = {
		"com.apple.DiscRecording:registrar" = mach-port-object;
		"com.apple.finder.ServiceProvider" = mach-port-object;
	};
	"Label" = "com.apple.Finder";
	"OnDemand" = true;
	"LastExitStatus" = 15;
	"PID" = 31259;
	"Program" = "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder";
};
`;

/** Real captured `launchctl list com.apple.progressd` — loaded, not running: no `"PID"` key at all. */
const LAUNCHCTL_LIST_LOADED_NOT_RUNNING = `{
	"EnableTransactions" = true;
	"LimitLoadToSessionType" = "Aqua";
	"MachServices" = {
		"com.apple.progressd" = mach-port-object;
		"com.apple.progressd.aps" = mach-port-object;
	};
	"Label" = "com.apple.progressd";
	"OnDemand" = true;
	"LastExitStatus" = 9;
	"Program" = "/System/Library/Frameworks/ClassKit.framework/Versions/A/progressd";
};
`;

/** Real captured stderr and exit code (113) from `launchctl list com.google.keystone.agent` — never loaded. */
const LAUNCHCTL_NOT_LOADED_STDERR = `Could not find service "com.google.keystone.agent" in domain for port\n`;

it.effect("launchd backend: observe reports installed+enabled+running for a running job", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const plist = path.join(dir, "com.apple.Finder.plist");
    yield* fs.writeFileString(plist, "<plist/>");

    const backend = makeLaunchdBackend({ home: dir, path, fs });
    const observed = yield* backend.observe(
      "com.apple.Finder",
      plist,
      fakeExec(LAUNCHCTL_LIST_RUNNING),
    );
    expect(observed).toEqual({ installed: true, enabled: true, running: true });
  }).pipe(Effect.provide(layer)),
);

it.effect("launchd backend: observe reports enabled but not running when there's no PID key", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const plist = path.join(dir, "com.apple.progressd.plist");
    yield* fs.writeFileString(plist, "<plist/>");

    const backend = makeLaunchdBackend({ home: dir, path, fs });
    const observed = yield* backend.observe(
      "com.apple.progressd",
      plist,
      fakeExec(LAUNCHCTL_LIST_LOADED_NOT_RUNNING),
    );
    expect(observed).toEqual({ installed: true, enabled: true, running: false });
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "launchd backend: a label launchd has never heard of reports not enabled, not running, not installed",
  () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      // Nothing written here at all — the default `~/Library/LaunchAgents/<name>.plist` path resolved from this `home` genuinely does not exist.
      const dir = yield* fs.makeTempDirectoryScoped();

      const backend = makeLaunchdBackend({ home: dir, path, fs });
      const observed = yield* backend.observe(
        "com.google.keystone.agent",
        undefined,
        failingExec(113, LAUNCHCTL_NOT_LOADED_STDERR),
      );
      expect(observed).toEqual({ installed: false, enabled: false, running: false });
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "launchd backend: the default plist path is <home>/Library/LaunchAgents/<name>.plist",
  () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const expected = path.join(dir, "Library", "LaunchAgents", "com.example.thing.plist");
      yield* fs.makeDirectory(path.join(dir, "Library", "LaunchAgents"), { recursive: true });
      yield* fs.writeFileString(expected, "<plist/>");

      const backend = makeLaunchdBackend({ home: dir, path, fs });
      const observed = yield* backend.observe(
        "com.example.thing",
        // No explicit path: falls back to the conventional location.
        undefined,
        failingExec(113, `Could not find service "com.example.thing" in domain for port\n`),
      );
      expect(observed.installed).toBe(true);
    }).pipe(Effect.provide(layer)),
);

it.effect("launchd backend: converge(enabled: true, running: true) loads then starts", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const { exec, calls } = queuedExec([{ stdout: "" }, { stdout: "" }]);

    const backend = makeLaunchdBackend({ home: "/home/test", path, fs });
    yield* backend.converge(
      "com.example.thing",
      "/custom/path/com.example.thing.plist",
      { enabled: true, running: true },
      exec,
    );
    expect(calls).toEqual([
      "launchctl load /custom/path/com.example.thing.plist",
      "launchctl start com.example.thing",
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("launchd backend: converge(enabled: false, running: false) unloads then stops", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const { exec, calls } = queuedExec([{ stdout: "" }, { stdout: "" }]);

    const backend = makeLaunchdBackend({ home: "/home/test", path, fs });
    yield* backend.converge(
      "com.example.thing",
      "/custom/path/com.example.thing.plist",
      { enabled: false, running: false },
      exec,
    );
    expect(calls).toEqual([
      "launchctl unload /custom/path/com.example.thing.plist",
      "launchctl stop com.example.thing",
    ]);
  }).pipe(Effect.provide(layer)),
);

// ---------------------------------------------------------------------------
// backends/linux/SystemdUser.ts — UNVERIFIED on real hardware (this machine
// is a Mac), but genuinely verified against a real, booted `systemd --user`
// instance in a container — see `SystemdUser.ts`'s doc comment for the full
// transcript this fixture data is drawn from verbatim. `enable`/`disable`
// were the one pair not executed; their exit-code mapping below follows
// upstream documentation instead, called out per-test.
// ---------------------------------------------------------------------------

it.effect(
  "systemd-user backend: observe reports installed+not-enabled+not-running for a fresh, never-enabled unit",
  () =>
    Effect.gen(function* () {
      const backend = makeSystemdUserBackend();
      // Real captured: `systemctl --user is-enabled mrtest.service` → stdout
      // "disabled", exit 1. `systemctl --user is-active mrtest.service` →
      // stdout "inactive", exit 3.
      const { exec } = queuedExec([
        { exitCode: 1, stderr: "disabled\n" },
        { exitCode: 3, stderr: "inactive\n" },
      ]);
      const observed = yield* backend.observe("mrtest.service", undefined, exec);
      expect(observed).toEqual({ installed: true, enabled: false, running: false });
    }),
);

it.effect(
  "systemd-user backend: is-enabled exit 4 (not-found) short-circuits without checking is-active",
  () =>
    Effect.gen(function* () {
      const backend = makeSystemdUserBackend();
      // Real captured: `systemctl --user is-enabled does-not-exist.service` →
      // stdout "not-found", exit 4.
      const { exec, calls } = queuedExec([{ exitCode: 4, stderr: "not-found\n" }]);
      const observed = yield* backend.observe("does-not-exist.service", undefined, exec);
      expect(observed).toEqual({ installed: false, enabled: false, running: false });
      expect(calls).toHaveLength(1);
    }),
);

it.effect(
  "systemd-user backend: a running-but-never-enabled unit is reported honestly as enabled=false, running=true " +
    "(live-captured: starting a unit never touches its enablement)",
  () =>
    Effect.gen(function* () {
      const backend = makeSystemdUserBackend();
      // Real captured, after `systemctl --user start mrtest.service`:
      // `is-enabled mrtest.service` → stdout "disabled", exit 1 (unchanged —
      // starting never enables). `is-active mrtest.service` → stdout
      // "active", exit 0.
      const { exec } = queuedExec([{ exitCode: 1, stderr: "disabled\n" }, { stdout: "active\n" }]);
      const observed = yield* backend.observe("mrtest.service", undefined, exec);
      expect(observed).toEqual({ installed: true, enabled: false, running: true });
    }),
);

it.effect(
  "systemd-user backend: is-enabled exit 0 is read as enabled — sourced from upstream docs, not a live capture " +
    "(this session's sandbox blocked the `enable` command itself; see SystemdUser.ts's doc comment)",
  () =>
    Effect.gen(function* () {
      const backend = makeSystemdUserBackend();
      const { exec } = queuedExec([{ stdout: "enabled\n" }, { stdout: "active\n" }]);
      const observed = yield* backend.observe("mrtest.service", undefined, exec);
      expect(observed).toEqual({ installed: true, enabled: true, running: true });
    }),
);

it.effect("systemd-user backend: converge issues enable/disable and start/stop independently", () =>
  Effect.gen(function* () {
    const backend = makeSystemdUserBackend();
    // `start` is live-verified (exit 0); `enable`'s exit code is documented,
    // not run — see this file's header comment.
    const { exec, calls } = queuedExec([{ stdout: "" }, { stdout: "" }]);
    yield* backend.converge("mrtest.service", undefined, { enabled: true, running: true }, exec);
    expect(calls).toEqual([
      "systemctl --user enable mrtest.service",
      "systemctl --user start mrtest.service",
    ]);
  }),
);

// ---------------------------------------------------------------------------
// backends/macos/BrewServices.ts
// ---------------------------------------------------------------------------

/**
 * Real, captured `brew services info transmission-cli --json` — a formula
 * installed on this machine via Homebrew with a service stanza, never
 * started (read-only; this backend was never asked to mutate it).
 */
const BREW_INFO_NEVER_STARTED = JSON.stringify([
  {
    name: "transmission-cli",
    service_name: "homebrew.mxcl.transmission-cli",
    running: false,
    loaded: false,
    schedulable: false,
    pid: null,
    exit_code: null,
    user: null,
    status: "none",
    file: "/opt/homebrew/opt/transmission-cli/homebrew.mxcl.transmission-cli.plist",
    registered: false,
    loaded_file: null,
    command:
      "/opt/homebrew/opt/transmission-cli/bin/transmission-daemon --foreground --config-dir /opt/homebrew/var/transmission/ --log-info --logfile /opt/homebrew/var/transmission/transmission-daemon.log",
    working_dir: null,
    root_dir: null,
    log_path: null,
    error_log_path: null,
    interval: null,
    cron: null,
  },
]);

/**
 * Same real field set as {@link BREW_INFO_NEVER_STARTED} (`registered`,
 * `loaded`, `running` — confirmed against `Homebrew::Services::FormulaWrapper#to_hash`
 * directly, see `BrewServices.ts`'s doc comment), with the three booleans
 * flipped to exercise the "fully up" reading. The *shape* is real; these
 * specific boolean values were not captured live — nothing on this machine
 * was started to get them, per this task's read-only constraint.
 */
const brewInfoWith = (registered: boolean, loaded: boolean, running: boolean): string =>
  JSON.stringify([{ registered, loaded, running }]);

it.effect(
  "brew-services backend: observe maps registered/loaded/running to installed/enabled/running",
  () =>
    Effect.gen(function* () {
      const backend = makeBrewServicesBackend();
      const observed = yield* backend.observe(
        "transmission-cli",
        undefined,
        fakeExec(BREW_INFO_NEVER_STARTED),
      );
      expect(observed).toEqual({ installed: false, enabled: false, running: false });
    }),
);

it.effect(
  "brew-services backend: observe reports a fully registered, loaded and running service",
  () =>
    Effect.gen(function* () {
      const backend = makeBrewServicesBackend();
      const observed = yield* backend.observe(
        "some-formula",
        undefined,
        fakeExec(brewInfoWith(true, true, true)),
      );
      expect(observed).toEqual({ installed: true, enabled: true, running: true });
    }),
);

it.effect("brew-services backend: converge(true, true) issues a single `start`", () =>
  Effect.gen(function* () {
    const backend = makeBrewServicesBackend();
    const { exec, calls } = queuedExec([{ stdout: "" }]);
    yield* backend.converge("thing", undefined, { enabled: true, running: true }, exec);
    expect(calls).toEqual(["brew services start thing"]);
  }),
);

it.effect(
  "brew-services backend: converge(true, false) starts then kills — no single verb reaches this from cold",
  () =>
    Effect.gen(function* () {
      const backend = makeBrewServicesBackend();
      const { exec, calls } = queuedExec([{ stdout: "" }, { stdout: "" }]);
      yield* backend.converge("thing", undefined, { enabled: true, running: false }, exec);
      expect(calls).toEqual(["brew services start thing", "brew services kill thing"]);
    }),
);

it.effect("brew-services backend: converge(false, true) stops then runs unregistered", () =>
  Effect.gen(function* () {
    const backend = makeBrewServicesBackend();
    const { exec, calls } = queuedExec([{ stdout: "" }, { stdout: "" }]);
    yield* backend.converge("thing", undefined, { enabled: false, running: true }, exec);
    expect(calls).toEqual(["brew services stop thing", "brew services run thing"]);
  }),
);

it.effect("brew-services backend: converge(false, false) issues a single `stop`", () =>
  Effect.gen(function* () {
    const backend = makeBrewServicesBackend();
    const { exec, calls } = queuedExec([{ stdout: "" }]);
    yield* backend.converge("thing", undefined, { enabled: false, running: false }, exec);
    expect(calls).toEqual(["brew services stop thing"]);
  }),
);
