import { expect, it } from "@effect/vitest";
import { CommandError, UnexpectedExit } from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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

/** Records every command, always succeeding — the shape the unapply tests need. */
const capturing = (calls: string[]) => ({
  exec: (p: { command: string }) => {
    calls.push(p.command);
    return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
  },
  snapshot: () => Effect.succeed(undefined),
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

      expect(Option.isSome(observed)).toBe(true);
      expect(reconciler.matches(Option.getOrThrow(observed), desired)).toBe(true);
    }),
);

it.effect("matches: a real difference in array order IS reported as drift", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeMacDefaultReconciler;

    const live = [1, 2, 3];
    const recipe = [3, 2, 1];

    const observed = yield* reconciler.observe(props(live), fakeExecOk(xmlOf(live)));
    const desired = yield* reconciler.desired(props(recipe));

    expect(Option.isSome(observed)).toBe(true);
    expect(reconciler.matches(Option.getOrThrow(observed), desired)).toBe(false);
  }),
);

it.effect(
  "drift: two spellings of the same value (different key order) report no drift, matching `matches`",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeMacDefaultReconciler;
      const live = { a: 1, b: 2 };
      const recipe = { b: 2, a: 1 };

      const observed = yield* reconciler.observe(props(live), fakeExecOk(xmlOf(live)));
      const desired = yield* reconciler.desired(props(recipe));

      expect(reconciler.drift?.(Option.getOrThrow(observed), desired)).toEqual([]);
    }),
);

it.effect(
  "drift: a real value difference reports \"value\" with the canonical XML on each side, no direction",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeMacDefaultReconciler;
      const observed = yield* reconciler.observe(props(1), fakeExecOk(xmlOf(1)));
      const desired = yield* reconciler.desired(props(2));

      const drift = reconciler.drift?.(Option.getOrThrow(observed), desired) ?? [];
      expect(drift).toHaveLength(1);
      expect(drift[0]?.field).toBe("value");
      expect(drift[0]?.direction).toBeUndefined();
      expect(drift[0]?.observed).toBe(xmlOf(1));
      expect(drift[0]?.desired).toBe(xmlOf(2));
    }),
);

/**
 * `unapply` exists because the prior value is now captured, not because a rule
 * changed. `Reconciler.unapply`'s doc comment used to cite this resource as the
 * example of one that cannot honestly reverse itself — the reason was that
 * `MacDefaultState` carried no prior value, which was a gap in the schema rather
 * than a fact about `defaults`. `apply` already receives the live value as
 * `observed`.
 */
it.effect("unapply restores the value it overwrote", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeMacDefaultReconciler;
    const unapply = reconciler.unapply;
    if (unapply === undefined) return yield* Effect.die("expected unapply to be defined");
    const calls: string[] = [];

    yield* unapply(
      {
        props: props(42),
        observed: { domain: "com.apple.finder", key: "ShowPathbar", xml: "<integer>42</integer>" },
        recorded: {
          domain: "com.apple.finder",
          key: "ShowPathbar",
          xml: "<integer>42</integer>",
          previous: { _tag: "Value", xml: "<true/>" },
        },
      },
      capturing(calls),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("defaults write");
    expect(calls[0]).toContain("<true/>");
  }),
);

it.effect("unapply deletes a key that did not exist before the apply", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeMacDefaultReconciler;
    const unapply = reconciler.unapply;
    if (unapply === undefined) return yield* Effect.die("expected unapply to be defined");
    const calls: string[] = [];

    yield* unapply(
      {
        props: props(42),
        observed: { domain: "com.apple.finder", key: "ShowPathbar", xml: "<integer>42</integer>" },
        recorded: {
          domain: "com.apple.finder",
          key: "ShowPathbar",
          xml: "<integer>42</integer>",
          previous: { _tag: "Absent" },
        },
      },
      capturing(calls),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("defaults delete");
  }),
);

/**
 * The case that keeps this honest. State written before `previous` existed has no
 * capture, and guessing would mean deleting a key the operator may have set
 * themselves — the worst available outcome.
 */
it.effect("unapply does nothing when no prior value was captured", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeMacDefaultReconciler;
    const unapply = reconciler.unapply;
    if (unapply === undefined) return yield* Effect.die("expected unapply to be defined");
    const calls: string[] = [];

    yield* unapply(
      {
        props: props(42),
        observed: { domain: "com.apple.finder", key: "ShowPathbar", xml: "<integer>42</integer>" },
        recorded: { domain: "com.apple.finder", key: "ShowPathbar", xml: "<integer>42</integer>" },
      },
      capturing(calls),
    );

    expect(calls).toEqual([]);
  }),
);

it.effect(
  "observe reports absent when the domain or key doesn't exist (plutil/defaults exits non-zero)",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeMacDefaultReconciler;
      const observed = yield* reconciler.observe(props(true), fakeExecFailing());
      expect(Option.isNone(observed)).toBe(true);
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
      { props: props(42), observed: Option.none(), desired },
      capturingExec,
    );

    // `previous` records that the key was absent, which is what `observed:
    // Option.none()` above means — that capture is what makes `unapply` honest.
    expect(result).toEqual({ ...desired, previous: { _tag: "Absent" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("defaults write");
    expect(calls[0]).toContain("com.apple.finder");
  }),
);
