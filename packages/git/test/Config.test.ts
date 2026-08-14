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
import * as Result from "effect/Result";
import {
  canonicalBool,
  GitConfigCommandFailed,
  GitConfigInvalidBoolean,
  makeGitConfigReconciler,
  type GitConfigProps,
} from "../src/Config.ts";

const layer = Layer.mergeAll(MachinePathsLive(), PlatformLive(), PlatformLive()).pipe(Layer.provideMerge(NodeServices.layer));

/** A `MachinePaths` whose home is a fixed temp directory — see `Symlink.test.ts`. */
const withHome = (home: string, path: Path.Path) =>
  Layer.succeed(MachinePaths, {
    home,
    expand: (target: string) => expandHome(path, target, home),
  });

/** A fake `Exec` returning fixed, real-captured stdout for every command. */
const fakeExecOk = (stdout: string) => ({
  exec: () => Effect.succeed({ exitCode: 0, stdout, stderr: "" }),
});

/** A fake `Exec` that fails the way the real `CommandExecutor` does when git exits non-zero. */
const fakeExecExit = (exitCode: number, stderr = "") => ({
  exec: () =>
    Effect.fail(
      new CommandError({
        command: "git config --global --get-all -z ...",
        reason: new UnexpectedExit({ exitCode, stderr }),
      }),
    ),
});

/** Records every command it's asked to run, always succeeding with empty output. */
const capturingExec = (calls: string[]) => ({
  exec: (commandProps: { command: string }) => {
    calls.push(commandProps.command);
    return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
  },
});

const applyCtx = (exec: Exec) => ({
  exec,
  snapshot: () => Effect.succeed(undefined),
});

const props = (overrides: Partial<GitConfigProps> = {}): GitConfigProps => ({
  key: "user.name",
  values: ["Agusti Fernandez"],
  ...overrides,
});

// --- canonicalBool: git's documented boolean literal table (`man git-config`, "Values"), verified live. ---

it("canonicalBool accepts every documented true/false literal, case-insensitively", () => {
  for (const literal of ["yes", "on", "true", "1", "YES", "On", "TRUE"]) {
    expect(Result.getOrThrow(canonicalBool("k", literal))).toBe("true");
  }
  for (const literal of ["no", "off", "false", "0", "", "NO", "Off"]) {
    expect(Result.getOrThrow(canonicalBool("k", literal))).toBe("false");
  }
});

it("canonicalBool rejects anything else, the same way `git config --type=bool` would", () => {
  const result = canonicalBool("weird.bool", "maybe");
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(GitConfigInvalidBoolean);
  }
});

// --- observe: real captured `git config --global --get-all -z` behaviour. ---

it.effect("observe reports absent when the key is unset (real exit code 1)", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeGitConfigReconciler;
    // Verified against real git 2.50.1: `--get-all` on an unset key exits 1
    // with empty stdout.
    const observed = yield* reconciler.observe(props(), fakeExecExit(1));
    expect(Option.isNone(observed)).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "observe parses NUL-terminated multi-value output, dropping the trailing terminator",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeGitConfigReconciler;
      // Real captured output of `git config --global --get-all -z multi.key`
      // after `--add multi.key val1` then `--add multi.key val2`.
      const observed = yield* reconciler.observe(
        props({ key: "multi.key", values: ["val1", "val2"] }),
        fakeExecOk("val1\0val2\0"),
      );
      expect(observed).toEqual(Option.some({ key: "multi.key", values: ["val1", "val2"] }));
    }).pipe(Effect.provide(layer)),
);

it.effect("observe reads a valueless boolean entry as canonical `true` with --type=bool", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeGitConfigReconciler;
    // Real captured output: a hand-written `[core]\n\tbare` (no `=`) reads
    // back as the single NUL byte via `--get-all --type=bool -z` — i.e. one
    // value, "true".
    const observed = yield* reconciler.observe(
      props({ key: "core.bare", values: ["true"], type: "bool" }),
      fakeExecOk("true\0"),
    );
    expect(observed).toEqual(Option.some({ key: "core.bare", values: ["true"] }));
  }).pipe(Effect.provide(layer)),
);

it.effect("observe surfaces a real failure rather than treating it as absent", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeGitConfigReconciler;
    // Verified: `git config --global --get --type=bool <key>` on a value
    // that isn't a boolean literal exits 128 ("bad boolean config value"),
    // a code that must never be read as "nothing here".
    const error = yield* reconciler
      .observe(
        props({ type: "bool" }),
        fakeExecExit(128, "fatal: bad boolean config value 'maybe'"),
      )
      .pipe(Effect.flip);
    expect(error).toBeInstanceOf(GitConfigCommandFailed);
  }).pipe(Effect.provide(layer)),
);

// --- desired: canonicalisation mirrors git's own --type=bool read. ---

it.effect(
  "desired canonicalises a bool-typed value the same way observe's --type=bool read would",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeGitConfigReconciler;
      const desired = yield* reconciler.desired(
        props({ key: "push.autoSetupRemote", values: ["yes"], type: "bool" }),
      );
      // Verified live: `git config --global --type=bool push.autoSetupRemote
      // yes` stores canonical "true", not the literal "yes".
      expect(desired).toEqual({ key: "push.autoSetupRemote", values: ["true"] });
    }).pipe(Effect.provide(layer)),
);

it.effect("desired fails rather than silently storing an unrecognised bool literal", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeGitConfigReconciler;
    const error = yield* reconciler
      .desired(props({ values: ["maybe"], type: "bool" }))
      .pipe(Effect.flip);
    expect(error).toBeInstanceOf(GitConfigInvalidBoolean);
  }).pipe(Effect.provide(layer)),
);

// --- matches: order-sensitive array comparison. ---

it.effect("matches treats a different value order as drift", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeGitConfigReconciler;
    const observed = { key: "credential.helper", values: ["osxkeychain", "gh"] };
    const desired = { key: "credential.helper", values: ["gh", "osxkeychain"] };
    expect(reconciler.matches(observed, desired)).toBe(false);
  }).pipe(Effect.provide(layer)),
);

// --- drift: agrees with matches, and names its fields the way a reader would. ---

it.effect("drift is empty exactly when matches is true", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeGitConfigReconciler;
    const state = { key: "user.name", values: ["Agusti Fernandez"] };

    expect(reconciler.matches(state, state)).toBe(true);
    expect(reconciler.drift?.(state, state)).toEqual([]);
  }).pipe(Effect.provide(layer)),
);

it.effect("drift reports a 'value' field, with no direction, for a differing values array", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeGitConfigReconciler;
    const observed = { key: "credential.helper", values: ["osxkeychain"] };
    const desired = { key: "credential.helper", values: ["gh", "osxkeychain"] };

    expect(reconciler.matches(observed, desired)).toBe(false);
    expect(reconciler.drift?.(observed, desired)).toEqual([
      { field: "value", observed: "osxkeychain", desired: "gh, osxkeychain" },
    ]);
  }).pipe(Effect.provide(layer)),
);

// --- unapply: --unset-all, the same primitive `apply` uses, tolerating "already unset". ---

it.effect("unapply removes the key that apply set", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeGitConfigReconciler;
    const calls: string[] = [];
    const recorded = { key: "credential.helper", values: ["osxkeychain"] };

    yield* reconciler.unapply!(
      { props: props(), observed: recorded, recorded },
      applyCtx(capturingExec(calls).exec),
    );

    expect(calls).toEqual(["git config --global --unset-all credential.helper"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("unapply tolerates the real exit code 5 for a key already unset", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeGitConfigReconciler;
    const recorded = { key: "credential.helper", values: ["osxkeychain"] };

    yield* reconciler.unapply!(
      { props: props(), observed: recorded, recorded },
      applyCtx(fakeExecExit(5).exec),
    );
  }).pipe(Effect.provide(layer)),
);

// --- apply: always unset-all then one --add per desired value, converging from any prior state. ---

it.effect("apply clears every existing value before re-adding, tolerating 'nothing to unset'", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeGitConfigReconciler;
    const calls: string[] = [];
    // First call (`--unset-all`) simulates the real exit code 5 git returns
    // for a key that was never set; later calls (the `--add`s) succeed.
    let first = true;
    const exec = (commandProps: { command: string }) => {
      calls.push(commandProps.command);
      if (first) {
        first = false;
        return Effect.fail(
          new CommandError({
            command: commandProps.command,
            reason: new UnexpectedExit({ exitCode: 5, stderr: "" }),
          }),
        );
      }
      return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
    };

    const desiredProps = props({ key: "credential.helper", values: ["osxkeychain", "gh"] });
    const desired = yield* reconciler.desired(desiredProps);
    const result = yield* reconciler.apply(
      { props: desiredProps, observed: Option.none(), desired },
      applyCtx(exec),
    );

    expect(result).toEqual(desired);
    expect(calls).toEqual([
      "git config --global --unset-all credential.helper",
      "git config --global --add credential.helper osxkeychain",
      "git config --global --add credential.helper gh",
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("apply passes --type=bool through to both the unset key and every --add", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeGitConfigReconciler;
    const calls: string[] = [];
    const desiredProps = props({ key: "commit.gpgsign", values: ["true"], type: "bool" });
    const desired = yield* reconciler.desired(desiredProps);
    yield* reconciler.apply(
      { props: desiredProps, observed: Option.none(), desired },
      applyCtx(capturingExec(calls).exec),
    );

    expect(calls).toEqual([
      "git config --global --unset-all commit.gpgsign",
      "git config --global --type=bool --add commit.gpgsign true",
    ]);
  }).pipe(Effect.provide(layer)),
);

// --- address: resolves the file `git config --global` actually reads/writes, once. ---

it.effect("address resolves to ~/.gitconfig when no XDG git config file exists", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();

    // Pinned explicitly rather than relying on this process's real
    // environment happening not to have `XDG_CONFIG_HOME` set — see the
    // next test's comment for why a provided `ConfigProvider` is the
    // reliable way to control this in a test.
    const reconciler = yield* makeGitConfigReconciler.pipe(
      Effect.provide(withHome(home, path)),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: {} })),
    );

    expect(reconciler.address(props())).toBe(path.join(home, ".gitconfig"));
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "address prefers an already-existing $XDG_CONFIG_HOME/git/config, matching real git",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const xdgBase = path.join(home, "xdg-config");
      const xdgGitDir = path.join(xdgBase, "git");
      yield* fs.makeDirectory(xdgGitDir, { recursive: true });
      yield* fs.writeFileString(path.join(xdgGitDir, "config"), "");

      // `Config.string`'s default provider (`ConfigProvider.fromEnv()`) takes
      // a one-time snapshot of `process.env` at construction — verified by
      // reading `effect/src/ConfigProvider.ts`'s `fromEnv`, which spreads
      // `process.env` into a plain object rather than closing over it live.
      // Because that default is a memoised `Context.Reference`, mutating
      // `process.env` mid-test is invisible to it once any earlier test in
      // this file has already triggered its construction. Overriding the
      // service directly for this one Effect sidesteps that entirely, and is
      // the correct fix regardless — it doesn't depend on test order.
      const reconciler = yield* makeGitConfigReconciler.pipe(
        Effect.provide(withHome(home, path)),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env: { XDG_CONFIG_HOME: xdgBase } }),
        ),
      );

      expect(reconciler.address(props())).toBe(path.join(xdgGitDir, "config"));
    }).pipe(Effect.provide(layer)),
);
