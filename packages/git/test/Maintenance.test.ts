import { expandHome, MachinePaths, MachinePathsLive, PlatformLive } from "@machine-run/core";
import type { Exec } from "@machine-run/engine";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { CommandError, UnexpectedExit } from "alchemy/Command";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import {
  GitMaintenanceCommandFailed,
  GitMaintenanceRepoNotFound,
  GitMaintenanceSchedulerUnavailable,
  makeGitMaintenanceReconciler,
} from "../src/Maintenance.ts";

const layer = Layer.mergeAll(MachinePathsLive(), PlatformLive(), PlatformLive()).pipe(Layer.provideMerge(NodeServices.layer));

/** A `MachinePaths` whose home is a fixed temp directory — mirrors `Config.test.ts`. */
const withHome = (home: string, path: Path.Path) =>
  Layer.succeed(MachinePaths, {
    home,
    expand: (target: string) => expandHome(path, target, home),
  });

/** No `XDG_CONFIG_HOME` — `address` resolves to plain `~/.gitconfig`, mirroring `Config.test.ts`. */
const noXdg = ConfigProvider.fromEnv({ env: {} });

/**
 * Resolves `rev-parse --show-toplevel` to `root`, and answers
 * `git config --global --get-all -z maintenance.repo` with whichever paths
 * are in `registeredRepos` — real captured shapes: NUL-terminated entries
 * when the key holds values, exit `1` with empty stdout when wholly unset
 * (verified against real git 2.43.0, `docs/notes/git-notes.md`).
 */
const maintenanceExec =
  (root: string, registeredRepos: readonly string[]): Exec =>
  (props) => {
    if (props.command.includes("show-toplevel")) {
      return Effect.succeed({ exitCode: 0, stdout: `${root}\n`, stderr: "" });
    }
    if (props.command.includes("get-all") && props.command.includes("maintenance.repo")) {
      return registeredRepos.length === 0
        ? Effect.fail(
            new CommandError({
              command: props.command,
              reason: new UnexpectedExit({ exitCode: 1, stderr: "" }),
            }),
          )
        : Effect.succeed({
            exitCode: 0,
            stdout: registeredRepos.map((repo) => `${repo}\0`).join(""),
            stderr: "",
          });
    }
    return Effect.die(`unexpected command in test: ${props.command}`);
  };

/** Fails the way `rev-parse --show-toplevel` does for a path outside any repository. */
const notARepoExec: Exec = () =>
  Effect.fail(
    new CommandError({
      command: "git rev-parse --show-toplevel",
      reason: new UnexpectedExit({
        exitCode: 128,
        stderr: "fatal: not a git repository (or any of the parent directories): .git",
      }),
    }),
  );

/** Records every command it's asked to run, always succeeding with empty output. */
const capturingExec =
  (calls: string[]): Exec =>
  (props) => {
    calls.push(props.command);
    return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
  };

/** Fails every command the real way `git maintenance start` does with no cron/systemd. */
const noSchedulerExec: Exec = (props) =>
  Effect.fail(
    new CommandError({
      command: props.command,
      reason: new UnexpectedExit({
        exitCode: 128,
        stderr: "fatal: neither systemd timers nor crontab are available",
      }),
    }),
  );

const applyCtx = (exec: Exec) => ({
  exec,
  snapshot: () => Effect.succeed(undefined),
});

const observeCtx = (exec: Exec) => ({ exec });

// --- observe: real captured `rev-parse --show-toplevel` + `--get-all -z maintenance.repo` shapes. ---

it.effect("observe reports absent when the repository is not registered at all", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeGitMaintenanceReconciler;
    // Verified: `--get-all` on a wholly unset `maintenance.repo` exits 1 with
    // empty stdout, the same as any other unset git config key.
    const observed = yield* reconciler.observe(
      { repo: "/repo" },
      observeCtx(maintenanceExec("/repo", [])),
    );
    expect(Option.isNone(observed)).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("observe reports absent when other repositories are registered but this one is not", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeGitMaintenanceReconciler;
    const observed = yield* reconciler.observe(
      { repo: "/repo" },
      observeCtx(maintenanceExec("/repo", ["/other-repo", "/yet-another"])),
    );
    expect(Option.isNone(observed)).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("observe reports the repo when it's registered, among others", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeGitMaintenanceReconciler;
    const observed = yield* reconciler.observe(
      { repo: "/repo" },
      observeCtx(maintenanceExec("/repo", ["/other-repo", "/repo"])),
    );
    expect(observed).toEqual(Option.some({ repo: "/repo" }));
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "observe fails with GitMaintenanceRepoNotFound when the path isn't a git repository at all " +
    "— unlike Git.Repo, this resource never creates one",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeGitMaintenanceReconciler;
      const error = yield* reconciler
        .observe({ repo: "/not-a-repo" }, observeCtx(notARepoExec))
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(GitMaintenanceRepoNotFound);
    }).pipe(Effect.provide(layer)),
);

it.effect("observe surfaces a real command failure rather than treating it as absent", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeGitMaintenanceReconciler;
    const error = yield* reconciler
      .observe(
        { repo: "/repo" },
        observeCtx(() =>
          Effect.fail(
            new CommandError({
              command: "git rev-parse --show-toplevel",
              reason: new UnexpectedExit({ exitCode: 128, stderr: "fatal: unknown corruption" }),
            }),
          ),
        ),
      )
      .pipe(Effect.flip);
    expect(error).toBeInstanceOf(GitMaintenanceCommandFailed);
  }).pipe(Effect.provide(layer)),
);

// --- matches: literal equality over the one field. ---

it.effect("matches is true iff the (expanded) repo path is identical", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeGitMaintenanceReconciler;
    expect(reconciler.matches({ repo: "/repo" }, { repo: "/repo" })).toBe(true);
    expect(reconciler.matches({ repo: "/repo" }, { repo: "/other" })).toBe(false);
  }).pipe(Effect.provide(layer)),
);

// --- drift: agrees with matches over the one field, `repo` — no direction, it's a path. ---

it.effect("drift is empty exactly when matches is true", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeGitMaintenanceReconciler;
    expect(reconciler.matches({ repo: "/repo" }, { repo: "/repo" })).toBe(true);
    expect(reconciler.drift?.({ repo: "/repo" }, { repo: "/repo" })).toEqual([]);
  }).pipe(Effect.provide(layer)),
);

it.effect("drift reports a 'repo' field for a differing repo", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeGitMaintenanceReconciler;
    expect(reconciler.matches({ repo: "/repo" }, { repo: "/other" })).toBe(false);
    expect(reconciler.drift?.({ repo: "/repo" }, { repo: "/other" })).toEqual([
      { field: "repo", observed: "/repo", desired: "/other" },
    ]);
  }).pipe(Effect.provide(layer)),
);

// --- apply: `git maintenance start`, and its one real, common failure mode. ---

it.effect("apply runs `git maintenance start` against the repo and returns desired", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeGitMaintenanceReconciler;
    const props = { repo: "/repo" };
    const desired = yield* reconciler.desired(props);
    const calls: string[] = [];

    const result = yield* reconciler.apply(
      { props, observed: Option.none(), desired },
      applyCtx(capturingExec(calls)),
    );

    expect(result).toEqual({ repo: "/repo" });
    expect(calls).toEqual(["git -C /repo maintenance start"]);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "apply fails with GitMaintenanceSchedulerUnavailable when neither systemd timers nor " +
    "crontab exist — container-verified exact failure, not a generic command error",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeGitMaintenanceReconciler;
      const props = { repo: "/repo" };
      const desired = yield* reconciler.desired(props);

      const error = yield* reconciler
        .apply({ props, observed: Option.none(), desired }, applyCtx(noSchedulerExec))
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(GitMaintenanceSchedulerUnavailable);
    }).pipe(Effect.provide(layer)),
);

it.effect("apply fails with the generic GitMaintenanceCommandFailed for any other failure", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeGitMaintenanceReconciler;
    const props = { repo: "/repo" };
    const desired = yield* reconciler.desired(props);

    const error = yield* reconciler
      .apply(
        { props, observed: Option.none(), desired },
        applyCtx(() =>
          Effect.fail(
            new CommandError({
              command: "git maintenance start",
              reason: new UnexpectedExit({ exitCode: 1, stderr: "fatal: something else broke" }),
            }),
          ),
        ),
      )
      .pipe(Effect.flip);

    expect(error).toBeInstanceOf(GitMaintenanceCommandFailed);
    expect(error).not.toBeInstanceOf(GitMaintenanceSchedulerUnavailable);
  }).pipe(Effect.provide(layer)),
);

// --- unapply: `git maintenance unregister --force`, deliberately never `stop` — see Maintenance.ts's doc comment. ---

it.effect(
  "unapply runs `git maintenance unregister --force` — never `stop`, which would silence " +
    "every other repository's background maintenance on the same machine",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeGitMaintenanceReconciler;
      const recorded = { repo: "/repo" };
      const calls: string[] = [];

      yield* reconciler.unapply!(
        { props: { repo: "/repo" }, observed: recorded, recorded },
        applyCtx(capturingExec(calls)),
      );

      expect(calls).toEqual(["git -C /repo maintenance unregister --force"]);
      expect(calls.some((call) => call.includes(" stop"))).toBe(false);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "unapply fails loudly (GitMaintenanceCommandFailed) rather than swallowing a real error",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeGitMaintenanceReconciler;
      const recorded = { repo: "/repo" };

      const error = yield* reconciler.unapply!(
        { props: { repo: "/repo" }, observed: recorded, recorded },
        applyCtx(() =>
          Effect.fail(
            new CommandError({
              command: "git maintenance unregister --force",
              reason: new UnexpectedExit({ exitCode: 1, stderr: "fatal: something else broke" }),
            }),
          ),
        ),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(GitMaintenanceCommandFailed);
    }).pipe(Effect.provide(layer)),
);

// --- address: shared with Git.Config's global config file, not the repo path. ---

it.effect(
  "address resolves to the same global config file Git.Config writes, not props.repo — " +
    "so a Git.Maintenance apply can never race a concurrent Git.Config write to it",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();

      const reconciler = yield* makeGitMaintenanceReconciler.pipe(
        Effect.provide(withHome(home, path)),
        Effect.provideService(ConfigProvider.ConfigProvider, noXdg),
      );

      expect(reconciler.address({ repo: "/repo" })).toBe(path.join(home, ".gitconfig"));
      // Independent of which repo the props name — this is a machine-wide
      // shared file, not a per-repo address.
      expect(reconciler.address({ repo: "/some/other/repo" })).toBe(path.join(home, ".gitconfig"));
    }).pipe(Effect.provide(layer)),
);
