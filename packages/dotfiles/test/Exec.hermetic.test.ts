import { NodeServices } from "@effect/platform-node";
import { MachinePathsLive, PlatformFor } from "@machine-run/core";
import { expect, it } from "@effect/vitest";
import { CommandError, UnexpectedExit } from "alchemy/Command";
import type { ApplyContext, Exec as RunExec } from "@machine-run/engine";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ExecGuardRequired, makeExecReconciler, type ExecProps } from "../src/Exec.ts";

const layer = Layer.mergeAll(MachinePathsLive(), PlatformFor("linux")).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const success = { exitCode: 0, stdout: "", stderr: "" };

const commandFailure = (command: string) =>
  new CommandError({
    command,
    reason: new UnexpectedExit({ exitCode: 7, stderr: "fixture failure" }),
  });

const context = (exec: RunExec): ApplyContext => ({
  exec,
  snapshot: () => Effect.succeed(undefined),
});

it.effect("observe rejects an unguarded command without invoking the executor", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeExecReconciler;
    const error = yield* reconciler
      .observe(
        { command: "true" },
        context(() => Effect.die("must not run")),
      )
      .pipe(Effect.flip);

    expect(error).toBeInstanceOf(ExecGuardRequired);
  }).pipe(Effect.provide(layer)),
);

it.effect("an unless guard interprets fake exit status without running a real shell", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeExecReconciler;
    const exec: RunExec = (props) =>
      props.command === "false"
        ? Effect.fail(commandFailure(props.command))
        : Effect.succeed(success);

    expect(yield* reconciler.observe({ command: "true", unless: "false" }, context(exec))).toEqual(
      Option.some({ satisfied: false }),
    );
    expect(yield* reconciler.observe({ command: "true", unless: "true" }, context(exec))).toEqual(
      Option.some({ satisfied: true }),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("apply delegates the command and reports a creates guard from the filesystem", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeExecReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const marker = path.join(dir, "marker");
    const props: ExecProps = { command: `touch ${marker}`, creates: marker };
    const desired = yield* reconciler.desired(props);
    const calls: string[] = [];
    const exec: RunExec = (command) => {
      calls.push(command.command);
      return fs.writeFileString(marker, "").pipe(Effect.as(success), Effect.orDie);
    };

    const before = yield* reconciler.observe(props, context(exec));
    const result = yield* reconciler.apply({ props, observed: before, desired }, context(exec));

    expect(result).toEqual({ satisfied: true });
    expect(calls).toEqual([props.command]);
    expect(yield* fs.exists(marker)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("a fake non-zero command remains a typed CommandError", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeExecReconciler;
    const props: ExecProps = { command: "exit 7", unless: "false" };
    const desired = yield* reconciler.desired(props);
    const error = yield* reconciler
      .apply(
        { props, observed: Option.none(), desired },
        context((command) => Effect.fail(commandFailure(command.command))),
      )
      .pipe(Effect.flip);

    expect(error).toBeInstanceOf(CommandError);
  }).pipe(Effect.provide(layer)),
);
