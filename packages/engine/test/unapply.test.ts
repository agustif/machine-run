import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Backups, FileLockLive, silentSession } from "@machine-run/core";
import { CommandExecutor } from "alchemy/Command";
import { RemovalPolicy } from "alchemy/RemovalPolicy";
import { Resource } from "alchemy/Resource";
import * as Boolean from "effect/Boolean";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { type Reconciler, toProvider } from "../src/index.ts";

/**
 * Proves `toProvider`'s `delete`/`RemovalPolicy`/`Reconciler.unapply` wiring
 * against a small reconciler defined only in this file — never against a real
 * package's resource, which other agents own (see `AGENTS.md` §4 and §6: a
 * reconciler's `observe`/`desired`/`matches`/`apply` are plain functions
 * callable directly, and here the thing under test is the adapter itself, one
 * level up, so its generated `delete` is what gets called directly).
 *
 * No Schema on props/state: nothing here crosses Alchemy's actual
 * serialization boundary — every object is constructed directly in-process —
 * so a schema would just be ceremony over a fixture.
 *
 * `RemovalPolicy` is provided with `Effect.provideService` rather than its
 * own `retain()`/`destroy()` pipeables: both pipeables require the wrapped
 * effect's error channel to already be `never` (they're meant to wrap an
 * already-fully-handled top-level program), which a raw `provider.delete`
 * call — typed `Effect.Effect<void, any, DeleteReq>` by Alchemy — is not.
 * Providing the service directly exercises exactly what `toProvider` reads
 * (`Effect.serviceOption(RemovalPolicy)`) without that constraint.
 */
interface TestFileProps {
  readonly path: string;
  readonly content: string;
}

interface TestFileState {
  readonly content: string;
  /**
   * Where `apply` archived whatever pre-existing content it overwrote, if
   * anything. Only ever set when `observed` was defined at apply time — this
   * reconciler's own prior writes are never "pre-existing" from its own point
   * of view, so they are never backed up.
   */
  readonly backupPath?: string;
}

interface TestFile extends Resource<"Test.Engine.File", TestFileProps, TestFileState> {}

const TestFile = Resource<TestFile>("Test.Engine.File");

/**
 * A minimal file resource demonstrating both honest `unapply` outcomes:
 * restore a real prior value when one was captured, or remove what this
 * resource itself created when nothing was ever displaced. `onUnapply` lets
 * a test assert whether the generated `delete` actually invoked it.
 */
const makeTestFileReconciler = (
  onUnapply: () => void,
): Effect.Effect<
  Reconciler<TestFileProps, TestFileState, PlatformError>,
  never,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const read = (path: string) =>
      fs.exists(path).pipe(
        Effect.flatMap((exists) =>
          Boolean.match(exists, {
            onFalse: () => Effect.succeed(Option.none()),
            onTrue: () => fs.readFileString(path).pipe(Effect.map((content) => Option.some({ content }))),
          }),
        ),
      );

    return {
      address: (props) => props.path,

      observe: (props) => read(props.path),

      desired: (props) => Effect.succeed({ content: props.content }),

      matches: (observed, desired) => observed.content === desired.content,

      apply: ({ props, observed, desired }, ctx) =>
        Effect.gen(function* () {
          // A real prior value only exists when something was already there
          // before this reconciler's first write — captured here, not via
          // `snapshotBeforeApply`, because only the reconciler itself can
          // fold the returned path into its own `State` for `unapply` to
          // recover later (see `Reconciler.unapply`'s doc comment: the
          // engine's own auto-snapshot discards the path for exactly this
          // reason — it has nowhere of its own to put it).
          const backupPath = yield* Option.match(observed, {
            onNone: () => Effect.succeed<string | undefined>(undefined),
            onSome: () => ctx.snapshot(props.path),
          });
          yield* fs.writeFileString(props.path, props.content);
          if (backupPath === undefined) return desired;
          return { ...desired, backupPath };
        }),

      unapply: ({ props, recorded }) =>
        Effect.gen(function* () {
          onUnapply();
          if (recorded.backupPath !== undefined) {
            const original = yield* fs.readFileString(recorded.backupPath);
            yield* fs.writeFileString(props.path, original);
          } else {
            // Nothing was ever displaced — the only honest undo is removing
            // what this resource itself created.
            yield* fs.remove(props.path);
          }
        }),
    };
  });

/** Same shape, but with nothing that knows how to undo anything. */
const makeNoUnapplyReconciler: Effect.Effect<
  Reconciler<TestFileProps, TestFileState, PlatformError>,
  never,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const read = (path: string) =>
    fs.exists(path).pipe(
      Effect.flatMap((exists) =>
        Boolean.match(exists, {
          onFalse: () => Effect.succeed(Option.none()),
          onTrue: () => fs.readFileString(path).pipe(Effect.map((content) => Option.some({ content }))),
        }),
      ),
    );

  return {
    address: (props) => props.path,
    observe: (props) => read(props.path),
    desired: (props) => Effect.succeed({ content: props.content }),
    matches: (observed, desired) => observed.content === desired.content,
    apply: ({ props, desired }) =>
      fs.writeFileString(props.path, props.content).pipe(Effect.as(desired)),
  };
});

/** Stub: this reconciler never calls `ctx.exec`, so nothing here runs. */
const CommandExecutorStub = Layer.succeed(CommandExecutor, {
  spawn: () => Effect.die("not used by this reconciler"),
  run: () => Effect.die("not used by this reconciler"),
});

/** Everything `toProvider` itself resolves, for any reconciler under test. */
const temporaryBackups = Layer.effect(
  Backups,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();

    return {
      root,
      snapshot: (target: string) =>
        Effect.gen(function* () {
          const destination = path.join(root, path.basename(target));
          yield* fs.copy(target, destination).pipe(Effect.orDie);
          return destination;
        }),
    };
  }),
);

const supportLayers = Layer.mergeAll(CommandExecutorStub, FileLockLive(), temporaryBackups).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const withTempFile = <A, E, R>(
  run: (path: string, fs: FileSystem.FileSystem) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    return yield* run(path.join(dir, "target.conf"), fs);
  });

it.effect(
  "under the default policy (no retain()/destroy() in scope), delete is a no-op even with unapply",
  () =>
    withTempFile((target, fs) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(target, "hand-written");
        let unapplyCalls = 0;
        const layer = toProvider(
          TestFile,
          makeTestFileReconciler(() => unapplyCalls++),
        );

        yield* Effect.gen(function* () {
          const provider = yield* TestFile.Provider;
          yield* provider.delete({
            id: "f",
            fqn: "f",
            instanceId: "f",
            olds: { path: target, content: "hand-written" },
            output: { content: "hand-written" },
            session: silentSession,
            bindings: [],
          });
        }).pipe(Effect.provide(layer));

        expect(unapplyCalls).toBe(0);
        expect(yield* fs.readFileString(target)).toBe("hand-written");
      }),
    ).pipe(Effect.scoped, Effect.provide(supportLayers)),
);

it.effect("under an explicit retain(), delete is a no-op", () =>
  withTempFile((target, fs) =>
    Effect.gen(function* () {
      yield* fs.writeFileString(target, "hand-written");
      let unapplyCalls = 0;
      const layer = toProvider(
        TestFile,
        makeTestFileReconciler(() => unapplyCalls++),
      );

      yield* Effect.gen(function* () {
        const provider = yield* TestFile.Provider;
        yield* provider.delete({
          id: "f",
          fqn: "f",
          instanceId: "f",
          olds: { path: target, content: "hand-written" },
          output: { content: "hand-written" },
          session: silentSession,
          bindings: [],
        });
      }).pipe(Effect.provide(layer), Effect.provideService(RemovalPolicy, "retain"));

      expect(unapplyCalls).toBe(0);
      expect(yield* fs.readFileString(target)).toBe("hand-written");
    }),
  ).pipe(Effect.scoped, Effect.provide(supportLayers)),
);

it.effect("under an explicit destroy(), a reconciler with no unapply is still a no-op", () =>
  withTempFile((target, fs) =>
    Effect.gen(function* () {
      yield* fs.writeFileString(target, "hand-written");
      const layer = toProvider(TestFile, makeNoUnapplyReconciler);

      yield* Effect.gen(function* () {
        const provider = yield* TestFile.Provider;
        yield* provider.delete({
          id: "f",
          fqn: "f",
          instanceId: "f",
          olds: { path: target, content: "hand-written" },
          output: { content: "hand-written" },
          session: silentSession,
          bindings: [],
        });
      }).pipe(Effect.provide(layer), Effect.provideService(RemovalPolicy, "destroy"));

      expect(yield* fs.readFileString(target)).toBe("hand-written");
    }),
  ).pipe(Effect.scoped, Effect.provide(supportLayers)),
);

it.effect(
  "under destroy(), unapply removes what this resource created when nothing pre-existed",
  () =>
    withTempFile((target, fs) =>
      Effect.gen(function* () {
        let unapplyCalls = 0;
        const layer = toProvider(
          TestFile,
          makeTestFileReconciler(() => unapplyCalls++),
        );

        yield* Effect.gen(function* () {
          const provider = yield* TestFile.Provider;

          // A first reconcile with nothing observed: `apply` creates the
          // file and records no `backupPath`, because there was nothing to
          // displace.
          const output = yield* provider.reconcile({
            id: "f",
            fqn: "f",
            instanceId: "f",
            news: { path: target, content: "generated" },
            olds: undefined,
            output: undefined,
            session: silentSession,
            bindings: [],
          });
          expect(output).toEqual({ content: "generated" });

          yield* provider.delete({
            id: "f",
            fqn: "f",
            instanceId: "f",
            olds: { path: target, content: "generated" },
            output,
            session: silentSession,
            bindings: [],
          });
        }).pipe(Effect.provide(layer), Effect.provideService(RemovalPolicy, "destroy"));

        expect(unapplyCalls).toBe(1);
        expect(yield* fs.exists(target)).toBe(false);
      }),
    ).pipe(Effect.scoped, Effect.provide(supportLayers)),
);

it.effect(
  "under destroy(), unapply restores the pre-existing content it backed up on adoption",
  () =>
    withTempFile((target, fs) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(target, "hand-written before machine-run");
        const layer = toProvider(
          TestFile,
          makeTestFileReconciler(() => {}),
        );

        yield* Effect.gen(function* () {
          const provider = yield* TestFile.Provider;

          // Adoption: `observe` finds the hand-written file, so `apply`
          // archives it via `ctx.snapshot` before overwriting.
          const output = yield* provider.reconcile({
            id: "f",
            fqn: "f",
            instanceId: "f",
            news: { path: target, content: "generated" },
            olds: undefined,
            output: undefined,
            session: silentSession,
            bindings: [],
          });
          expect(output.backupPath).toBeDefined();
          expect(yield* fs.readFileString(target)).toBe("generated");

          yield* provider.delete({
            id: "f",
            fqn: "f",
            instanceId: "f",
            olds: { path: target, content: "generated" },
            output,
            session: silentSession,
            bindings: [],
          });
        }).pipe(Effect.provide(layer), Effect.provideService(RemovalPolicy, "destroy"));

        // The machine ends up back where it was before this tool ever
        // touched it — not merely "gone" — which is the whole point of
        // restoring rather than deleting.
        expect(yield* fs.readFileString(target)).toBe("hand-written before machine-run");
      }),
    ).pipe(Effect.scoped, Effect.provide(supportLayers)),
);

it.effect("under destroy(), unapply is skipped when the target is already gone", () =>
  withTempFile((target, fs) =>
    Effect.gen(function* () {
      let unapplyCalls = 0;
      const layer = toProvider(
        TestFile,
        makeTestFileReconciler(() => unapplyCalls++),
      );

      yield* Effect.gen(function* () {
        const provider = yield* TestFile.Provider;
        const output = yield* provider.reconcile({
          id: "f",
          fqn: "f",
          instanceId: "f",
          news: { path: target, content: "generated" },
          olds: undefined,
          output: undefined,
          session: silentSession,
          bindings: [],
        });

        // Removed by something other than this tool between deploy and
        // destroy — `observe` inside `delete` must see that, not the
        // recorded `output`.
        yield* fs.remove(target);

        yield* provider.delete({
          id: "f",
          fqn: "f",
          instanceId: "f",
          olds: { path: target, content: "generated" },
          output,
          session: silentSession,
          bindings: [],
        });
      }).pipe(Effect.provide(layer), Effect.provideService(RemovalPolicy, "destroy"));

      expect(unapplyCalls).toBe(0);
      expect(yield* fs.exists(target)).toBe(false);
    }),
  ).pipe(Effect.scoped, Effect.provide(supportLayers)),
);
