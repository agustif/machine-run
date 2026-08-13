import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeAptBackend } from "../src/backends/Apt.ts";
import { makeBrewBackend, makeBrewCaskBackend } from "../src/backends/Brew.ts";
import { makeCargoBackend } from "../src/backends/Cargo.ts";
import { makePortBackend } from "../src/backends/MacPorts.ts";
import { makeNpmBackend } from "../src/backends/Npm.ts";
import type { CommandExecutorService } from "../src/Backend.ts";

const session = undefined as unknown as ScopedPlanStatusSession;

/** A fake CommandExecutor whose `run` returns a fixed stdout for every call — enough to unit test each backend's parsing/command shape without a real shell. */
const fakeExecutor = (stdout: string): CommandExecutorService =>
  ({
    run: () => Effect.succeed({ exitCode: 0, stdout, stderr: "" }),
    spawn: () => Effect.die("not used in these tests"),
  }) as unknown as CommandExecutorService;

const capturingExecutor = (stdout: string, calls: string[]): CommandExecutorService =>
  ({
    run: (props: { command: string }) => {
      calls.push(props.command);
      return Effect.succeed({ exitCode: 0, stdout, stderr: "" });
    },
    spawn: () => Effect.die("not used in these tests"),
  }) as unknown as CommandExecutorService;

it.effect("brew backend parses `brew list --formula` output into names", () =>
  Effect.gen(function* () {
    const backend = makeBrewBackend(fakeExecutor("mise\nripgrep\nfd\n"));
    const installed = yield* backend.list(session);
    expect(installed).toEqual(["mise", "ripgrep", "fd"]);
  }),
);

it.effect("brew backend install shells out to `brew install <name>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeBrewBackend(capturingExecutor("", calls));
    yield* backend.install("ripgrep", session);
    expect(calls).toEqual(["brew install ripgrep"]);
  }),
);

it.effect("brew-cask backend uses `brew install --cask`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeBrewCaskBackend(capturingExecutor("", calls));
    yield* backend.install("orbstack", session);
    expect(calls).toEqual(["brew install --cask orbstack"]);
  }),
);

it.effect("apt backend parses dpkg-query output into package names", () =>
  Effect.gen(function* () {
    const backend = makeAptBackend(fakeExecutor("curl\ngit\n"));
    const installed = yield* backend.list(session);
    expect(installed).toEqual(["curl", "git"]);
  }),
);

it.effect("port backend parses `port installed` output into names", () =>
  Effect.gen(function* () {
    const backend = makePortBackend(
      fakeExecutor("Port installed:\n  git @2.43.0_0 (active)\n  wget @1.24.5_0 (active)\n"),
    );
    const installed = yield* backend.list(session);
    expect(installed).toEqual(["git", "wget"]);
  }),
);

it.effect("cargo backend ignores indented binary lines from --list", () =>
  Effect.gen(function* () {
    const backend = makeCargoBackend(
      fakeExecutor("cargo-bloat v0.11.1:\n    cargo-bloat\nripgrep v14.0.0:\n    rg\n"),
    );
    const installed = yield* backend.list(session);
    expect(installed).toEqual(["cargo-bloat", "ripgrep"]);
  }),
);

it.effect("npm backend parses `npm ls -g --json` dependencies", () =>
  Effect.gen(function* () {
    const backend = makeNpmBackend(
      fakeExecutor(JSON.stringify({ dependencies: { typescript: {}, pnpm: {} } })),
    );
    const installed = yield* backend.list(session);
    expect(installed.sort()).toEqual(["pnpm", "typescript"]);
  }),
);

it.effect("npm backend surfaces a typed BackendParseError on malformed JSON", () =>
  Effect.gen(function* () {
    const backend = makeNpmBackend(fakeExecutor("not json"));
    const result = yield* Effect.flip(backend.list(session));
    expect(result._tag).toBe("BackendParseError");
  }),
);
