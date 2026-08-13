import { expect, it } from "@effect/vitest";
import { CommandError, UnexpectedExit } from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { makeMacDefaultReconciler, type MacDefaultProps } from "../src/Default.ts";
import { data, date, PlistDecodeError, render, type PlistValue } from "../src/Value.ts";

/** Unwraps a render the test expects to succeed, so fixtures read as plain XML strings. */
const xmlOf = (value: PlistValue): string => Result.getOrThrow(render(value));

/** A fake `Exec` returning fixed output for every command, regardless of what `observe`/`apply` asked for. */
const fakeExecOk = (stdout: string) => ({
  exec: () => Effect.succeed({ exitCode: 0, stdout, stderr: "" }),
});

/** A fake `Exec` that fails the way the real `CommandExecutor` does when `plutil`/`defaults` exits non-zero. */
const fakeExecFailing = () => ({
  exec: () =>
    Effect.fail(
      new CommandError({
        command: "defaults export ... | plutil -extract ...",
        reason: new UnexpectedExit({ exitCode: 1, stderr: "" }),
      }),
    ),
});

const props = (value: PlistValue): MacDefaultProps => ({
  domain: "com.apple.finder",
  key: "SomeKey",
  value,
});

it.effect(
  "matches: a structured value (dict + array + data + date) round-trips without reporting false drift when the live dict's keys are stored in a different order",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeMacDefaultReconciler;

      // The value as it lives on disk — keys in one order.
      const live = {
        blob: data("aGVsbG8="),
        when: date("2026-01-02T03:04:05.000Z"),
        z: 1,
        list: [3, "x", true],
        a: 2,
      };
      // The same value as a recipe spells it — keys in a different order.
      const recipe = {
        a: 2,
        list: [3, "x", true],
        z: 1,
        blob: data("aGVsbG8="),
        when: date("2026-01-02T03:04:05.000Z"),
      };

      const observed = yield* reconciler.observe(props(live), fakeExecOk(xmlOf(live)));
      const desired = yield* reconciler.desired(props(recipe));

      expect(observed).toBeDefined();
      expect(reconciler.matches(observed!, desired)).toBe(true);
    }),
);

it.effect("matches: a real difference in array order IS reported as drift", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeMacDefaultReconciler;

    const live = [1, 2, 3];
    const recipe = [3, 2, 1];

    const observed = yield* reconciler.observe(props(live), fakeExecOk(xmlOf(live)));
    const desired = yield* reconciler.desired(props(recipe));

    expect(observed).toBeDefined();
    expect(reconciler.matches(observed!, desired)).toBe(false);
  }),
);

it.effect(
  "observe reports absent when the domain or key doesn't exist (plutil/defaults exits non-zero)",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeMacDefaultReconciler;
      const observed = yield* reconciler.observe(props(true), fakeExecFailing());
      expect(observed).toBeUndefined();
    }),
);

it.effect(
  "observe fails with PlistDecodeError, not absence, when the command succeeds but the output doesn't parse",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeMacDefaultReconciler;
      const error = yield* reconciler
        .observe(props(true), fakeExecOk("this is not a property list"))
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(PlistDecodeError);
    }),
);

it.effect("apply writes the rendered XML and returns the desired state", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeMacDefaultReconciler;
    const calls: string[] = [];
    const capturingExec = {
      exec: (p: { command: string }) => {
        calls.push(p.command);
        return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
      },
      snapshot: () => Effect.succeed(undefined),
    };

    const desired = yield* reconciler.desired(props(42));
    const result = yield* reconciler.apply(
      { props: props(42), observed: undefined, desired },
      capturingExec,
    );

    expect(result).toEqual(desired);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("defaults write");
    expect(calls[0]).toContain("com.apple.finder");
  }),
);
