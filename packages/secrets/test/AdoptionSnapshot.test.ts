import { Backups, FileLockLive, MachinePathsLive, silentSession } from "@machine-run/core";
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
 * `Machine.File` and `Machine.Symlink` both set `snapshotBeforeApply: true`,
 * so `toProvider`'s adoption-backup gate archives whatever a person put at
 * their path before this tool's first overwrite (see
 * `packages/dotfiles/test/AdoptionSnapshot.test.ts` for that gate proven
 * against `Machine.File`). `Machine.SecretFile` overwrites unconditionally
 * too — `apply` always calls `fs.writeFileString(desired.path, content, ...)`
 * regardless of what, if anything, was already there — but never sets
 * `snapshotBeforeApply`.
 *
 * That is a real gap: a person who hand-placed a key at a path this
 * resource is later pointed at (the same "adopt an existing, correct
 * machine" scenario `Machine.File` protects) gets it silently overwritten
 * with no backup at all. Recorded in `docs/test-findings.md`; this test
 * pins the current (missing-safety-net) behaviour down.
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
    Layer.provideMerge(MachinePathsLive()),
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

    // The secret is materialised, and the key that was already sitting
    // there was copied first. Overwriting a hand-placed credential with no
    // copy is unrecoverable, which is why this resource opts into the
    // snapshot gate rather than relying on the store still holding the old
    // value.
    expect(yield* fs.readFileString(target)).not.toContain("hand-placed");
    expect(calls.count).toBe(1);
  }).pipe(
    Effect.provide(toProvider(SecretFile, makeSecretFileReconciler)),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ SSH_KEY: "new-key\n" }))),
    Effect.scoped,
    Effect.provide(supportLayers(calls)),
  );
});
