import {
  Backups,
  FileLockLive,
  MachinePathsLive,
  PlatformFor,
  silentSession,
} from "@machine-run/core";
import { NodeServices } from "@effect/platform-node";
import { toProvider } from "@machine-run/engine";
import { expect, it } from "@effect/vitest";
import { CommandExecutor } from "alchemy/Command";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { makeSecretFileReconciler, SecretFile } from "../src/SecretFile.ts";

/**
 * `Machine.SecretFile` opts into the same adoption-backup gate as
 * `Machine.File`: an explicit adoption can overwrite a hand-placed key only
 * after the engine has copied it. The backup is deliberately outside Alchemy
 * state; the secret bytes and the backup path are never persisted as secret
 * resource attributes. `BackupsLive` also applies restrictive permissions to
 * the backup, including the ACL path on Windows.
 */
const CommandExecutorStub = Layer.succeed(CommandExecutor, {
  spawn: () => Effect.die("Machine.SecretFile never runs a command for the `env` backend"),
  run: () => Effect.die("Machine.SecretFile never runs a command for the `env` backend"),
});

const fakeBackups = (calls: { count: number }) =>
  Layer.succeed(Backups, {
    root: "/fake/backups",
    snapshot: (target: string) =>
      Effect.sync(() => {
        calls.count += 1;
        return `/fake/backups/${target}`;
      }),
  });

const supportLayers = (calls: { count: number }) =>
  Layer.mergeAll(CommandExecutorStub, FileLockLive(), fakeBackups(calls)).pipe(
    Layer.provideMerge(Layer.mergeAll(MachinePathsLive(), PlatformFor("linux"))),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect("snapshots pre-existing, hand-placed content before overwriting it", () => {
  const calls = { count: 0 };
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "id_ed25519");
    yield* fs.writeFileString(target, "a hand-placed key, never written by this tool");

    const provider = yield* SecretFile.Provider;
    yield* provider.reconcile({
      id: "s",
      fqn: "s",
      instanceId: "s",
      news: { path: target, source: { _tag: "Env", variable: "SSH_KEY" } },
      // Nothing recorded yet — the same "true first apply, and the file
      // already has real content" situation that triggers a snapshot for
      // `Machine.File` (see the sibling test in `dotfiles`).
      olds: undefined,
      output: undefined,
      session: silentSession,
      bindings: [],
    });

    // The secret is materialised, and the key that was already sitting there
    // was copied first. Overwriting a hand-placed credential with no copy is
    // unrecoverable, which is why this resource opts into the snapshot gate.
    expect(yield* fs.readFileString(target)).not.toContain("hand-placed");
    expect(calls.count).toBe(1);
  }).pipe(
    Effect.provide(toProvider(SecretFile, makeSecretFileReconciler)),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ SSH_KEY: "new-key\n" }))),
    Effect.scoped,
    Effect.provide(supportLayers(calls)),
  );
});
