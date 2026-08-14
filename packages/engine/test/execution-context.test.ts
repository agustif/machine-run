import { NodeServices } from "@effect/platform-node";
import { services as coreServices, Sh } from "@machine-run/core";
import { CommandExecutor, type CommandRunProps } from "alchemy/Command";
import { Resource } from "alchemy/Resource";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { type Reconciler, toProvider } from "../src/index.ts";

interface TestExecutionProps {
  readonly value: string;
  readonly timeout?: Duration.Input;
}

interface TestExecutionState {
  readonly value: string;
}

interface TestExecution extends Resource<
  "Test.Engine.ExecutionContext",
  TestExecutionProps,
  TestExecutionState
> {}

const TestExecution = Resource<TestExecution>("Test.Engine.ExecutionContext");

const makeReconciler: Effect.Effect<Reconciler<TestExecutionProps, TestExecutionState, never>> =
  Effect.succeed({
    address: () => "execution-context-test",
    observe: (props, ctx) =>
      ctx
        .exec({
          command: Sh.sh("printf", "observed"),
          shell: true,
          ...(props.timeout === undefined ? {} : { timeout: props.timeout }),
        })
        .pipe(Effect.as(Option.some({ value: props.value })), Effect.orDie),
    desired: (props) => Effect.succeed({ value: props.value }),
    matches: (observed, desired) => observed.value === desired.value,
    apply: ({ desired }) => Effect.succeed(desired),
  });

const support = (calls: CommandRunProps[]) =>
  Layer.mergeAll(
    Layer.succeed(CommandExecutor, {
      spawn: () => Effect.die("spawn is not used by this test"),
      run: (props) => {
        calls.push(props);
        return Effect.succeed({
          exitCode: 0,
          stdout: props.command === "id -u" ? "0\n" : "",
          stderr: "",
        });
      },
    }),
    coreServices(),
  ).pipe(Layer.provideMerge(NodeServices.layer));

it.effect("toProvider applies locale and default timeout at the command boundary", () => {
  const calls: CommandRunProps[] = [];
  return Effect.gen(function* () {
    const provider = yield* TestExecution.Provider;
    const read = provider.read;
    if (read === undefined) return yield* Effect.die("toProvider did not expose read");

    yield* read({
      id: "test",
      fqn: "test",
      instanceId: "test",
      olds: { value: "default" },
      output: undefined,
    });

    const observed = calls.at(-1);
    expect(observed).toMatchObject({
      command: "printf observed",
      timeout: "10 minutes",
      env: { LC_ALL: "C", LANG: "C" },
    });
  }).pipe(
    Effect.provide(toProvider(TestExecution, makeReconciler)),
    Effect.provide(support(calls)),
  );
});

it.effect("toProvider preserves a reconciler's explicit timeout", () => {
  const calls: CommandRunProps[] = [];
  return Effect.gen(function* () {
    const provider = yield* TestExecution.Provider;
    const read = provider.read;
    if (read === undefined) return yield* Effect.die("toProvider did not expose read");

    yield* read({
      id: "test",
      fqn: "test",
      instanceId: "test",
      olds: { value: "explicit", timeout: "5 seconds" },
      output: undefined,
    });

    const observed = calls.at(-1);
    expect(observed).toMatchObject({ timeout: "5 seconds" });
  }).pipe(
    Effect.provide(toProvider(TestExecution, makeReconciler)),
    Effect.provide(support(calls)),
  );
});
