import { MachinePathsLive } from "@machine-run/core";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import {
  makeSecretFileReconciler,
  SecretFilePathUnreadable,
  type SecretFileProps,
} from "../src/SecretFile.ts";

const layer = MachinePathsLive().pipe(Layer.provideMerge(NodeServices.layer));

/** `ctx.exec` is unused by the `env` backend, so a stub that dies if it's ever called keeps that honest. */
const applyCtx = {
  exec: () => Effect.die("not used"),
  snapshot: () => Effect.succeed(undefined),
};
const observeCtx = { exec: () => Effect.die("not used") };

/**
 * Installs a fixed `ConfigProvider` for the duration of an effect, so the
 * `env` secret backend (which reads via `Config.redacted`) is exercised
 * against known values instead of this test process's real environment.
 */
const withEnv = <A, E, R>(vars: Record<string, string>, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(vars))));

const propsFor = (
  target: string,
  ref: string,
  overrides: Partial<SecretFileProps> = {},
): SecretFileProps => ({
  path: target,
  source: "env",
  ref,
  ...overrides,
});

/**
 * BUG (see docs/test-findings.md — the same class of bug also pins in
 * `packages/dotfiles/test/File.test.ts`): `observe` folds *any* `fs.stat`
 * failure into "absent" via `Effect.orElseSucceed(() => undefined)`, rather
 * than disambiguating "genuinely not there" from "could not be inspected"
 * the way `Machine.Symlink`'s reconciler does (raising a typed error for the
 * latter). For a secret file this is worse than for a plain one: it means a
 * permission problem on the parent directory is read as "nothing here yet",
 * and `apply` proceeds to fetch the secret from its backend and write it —
 * touching the vault for a fetch whose result may not even be storable.
 */
it.effect(
  "observe raises a typed error, not absence, when the parent directory is unreadable",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeSecretFileReconciler;
      const dir = yield* fs.makeTempDirectoryScoped();

      const blocked = path.join(dir, "blocked");
      yield* fs.makeDirectory(blocked);
      const target = path.join(blocked, "id_ed25519");
      yield* fs.writeFileString(target, "a key nobody can see right now", { mode: 0o600 });
      yield* fs.chmod(blocked, 0o000);

      // Reading "unreadable" as "absent" here would be worse than for an
      // ordinary file: `apply` would go on to fetch the secret from its store
      // and write it, answering a permissions problem by moving credential
      // material. Restored with `ensuring` so it survives interruption.
      const failure = yield* reconciler
        .observe(propsFor(target, "SSH_KEY"), observeCtx)
        .pipe(
          Effect.flip,
          Effect.ensuring(
            fs.chmod(blocked, 0o755).pipe(Effect.orElseSucceed(() => undefined)),
          ),
        );

      expect(failure).toBeInstanceOf(SecretFilePathUnreadable);
    }).pipe(Effect.provide(layer)),
);

it.effect("trailingNewline 'preserve' (the default) writes the backend's bytes verbatim", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeSecretFileReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "id_ed25519");

    // A real OpenSSH private key's shape: content, then a single trailing
    // newline, which "preserve" must leave exactly alone.
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc123\n-----END OPENSSH PRIVATE KEY-----\n";
    const props = propsFor(target, "SSH_KEY");
    const desired = yield* reconciler.desired(props);

    yield* withEnv(
      { SSH_KEY: key },
      reconciler.apply({ props, observed: undefined, desired }, applyCtx),
    );

    expect(yield* fs.readFileString(target)).toBe(key);
  }).pipe(Effect.provide(layer)),
);

it.effect("trailingNewline 'ensure' adds exactly one newline when the backend's value has none", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeSecretFileReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "token");

    const props = propsFor(target, "API_TOKEN", { trailingNewline: "ensure" });
    const desired = yield* reconciler.desired(props);

    yield* withEnv(
      { API_TOKEN: "no-newline-here" },
      reconciler.apply({ props, observed: undefined, desired }, applyCtx),
    );

    expect(yield* fs.readFileString(target)).toBe("no-newline-here\n");
  }).pipe(Effect.provide(layer)),
);

it.effect("trailingNewline 'ensure' does not double a newline that is already there", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeSecretFileReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "token");

    const props = propsFor(target, "API_TOKEN", { trailingNewline: "ensure" });
    const desired = yield* reconciler.desired(props);

    yield* withEnv(
      { API_TOKEN: "already-has-one\n" },
      reconciler.apply({ props, observed: undefined, desired }, applyCtx),
    );

    expect(yield* fs.readFileString(target)).toBe("already-has-one\n");
  }).pipe(Effect.provide(layer)),
);

it.effect("trailingNewline 'strip' removes trailing newlines a naive comparison would choke on", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeSecretFileReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "token");

    const props = propsFor(target, "API_TOKEN", { trailingNewline: "strip" });
    const desired = yield* reconciler.desired(props);

    yield* withEnv(
      { API_TOKEN: "a-token\n\n" },
      reconciler.apply({ props, observed: undefined, desired }, applyCtx),
    );

    expect(yield* fs.readFileString(target)).toBe("a-token");
  }).pipe(Effect.provide(layer)),
);

it.effect("mode defaults to 0600, and the directory holding it defaults to 0700", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeSecretFileReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const nested = path.join(dir, "ssh");
    const target = path.join(nested, "id_ed25519");

    const props = propsFor(target, "SSH_KEY");
    const desired = yield* reconciler.desired(props);
    expect(desired.mode).toBe(0o600);

    yield* withEnv(
      { SSH_KEY: "private-key-bytes\n" },
      reconciler.apply({ props, observed: undefined, desired }, applyCtx),
    );

    const fileInfo = yield* fs.stat(target);
    expect(Number(fileInfo.mode) & 0o777).toBe(0o600);
    const dirInfo = yield* fs.stat(nested);
    expect(Number(dirInfo.mode) & 0o777).toBe(0o700);
  }).pipe(Effect.provide(layer)),
);

it.effect("an explicit mode overrides the 0600 default", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeSecretFileReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "token");

    const props = propsFor(target, "API_TOKEN", { mode: 0o640 });
    const desired = yield* reconciler.desired(props);
    expect(desired.mode).toBe(0o640);

    yield* withEnv(
      { API_TOKEN: "a-token" },
      reconciler.apply({ props, observed: undefined, desired }, applyCtx),
    );

    const info = yield* fs.stat(target);
    expect(Number(info.mode) & 0o777).toBe(0o640);
  }).pipe(Effect.provide(layer)),
);

it.effect("observe reports absent before the first write, then presence and mode after it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeSecretFileReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "token");

    const props = propsFor(target, "API_TOKEN");
    expect(yield* reconciler.observe(props, observeCtx)).toBeUndefined();

    const desired = yield* reconciler.desired(props);
    yield* withEnv(
      { API_TOKEN: "a-token" },
      reconciler.apply({ props, observed: undefined, desired }, applyCtx),
    );

    // `observe` never reads the secret's own bytes back — only presence and
    // mode — so a rotated value behind the same `ref` is undetectable, by
    // design (see `SecretFileState`'s doc comment). What it must still catch
    // is the file's permissions being satisfied.
    const observed = yield* reconciler.observe(props, observeCtx);
    expect(observed).toEqual({ path: target, mode: 0o600 });
    expect(reconciler.matches(observed!, desired)).toBe(true);
  }).pipe(Effect.provide(layer)),
);
