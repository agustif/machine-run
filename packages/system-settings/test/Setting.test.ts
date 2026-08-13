import type { ApplyContext, Exec, ObserveContext } from "@machine-run/engine";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeSettingReconciler } from "../src/Setting.ts";

/** A command runner returning fixed output for every call it's asked to make. */
const fakeExec =
  (stdout: string): Exec =>
  () =>
    Effect.succeed({ exitCode: 0, stdout, stderr: "" });

/**
 * A command runner that answers `read` calls with one value and `write`
 * calls by recording them but changing nothing — this is exactly the shape
 * of `gsettings set`'s container-verified silent no-op with no session
 * D-Bus: the write "succeeds" (exit 0) but a subsequent read still returns
 * the old value.
 */
const noopWriteExec =
  (liveValue: string, calls: string[]): Exec =>
  (props) => {
    calls.push(props.command);
    return Effect.succeed({ exitCode: 0, stdout: liveValue, stderr: "" });
  };

/**
 * A command runner where a write genuinely takes effect on the next read —
 * unlike `noopWriteExec` above. `writtenValue` is exactly the GVariant text
 * a real write would have stored; deliberately not derived by parsing the
 * shell-quoted command string (fragile for a value like `['a', 'b']`, whose
 * quoting embeds literal spaces), the same way `capturingExec` elsewhere in
 * this repo records commands without trying to decode them.
 */
interface StatefulExec {
  readonly exec: Exec;
  readonly calls: string[];
}

const statefulExec = (initial: string | undefined, writtenValue: string): StatefulExec => {
  let current = initial;
  const calls: string[] = [];
  const exec: Exec = (props) => {
    calls.push(props.command);
    if (props.command.startsWith("gsettings set") || props.command.startsWith("dconf write")) {
      current = writtenValue;
      return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
    }
    return current === undefined
      ? Effect.succeed({ exitCode: 1, stdout: "", stderr: "not set" })
      : Effect.succeed({ exitCode: 0, stdout: current, stderr: "" });
  };
  return { exec, calls } satisfies StatefulExec;
};

const planCtx = (exec: Exec): ObserveContext => ({ exec });

const applyCtx = (exec: Exec): ApplyContext => ({
  exec,
  snapshot: () => Effect.die("System.Setting never snapshots — snapshotBeforeApply is unset"),
});

it.effect(
  "Setting reconciler address is backend:key, so two Settings on the same key contend",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeSettingReconciler;
      expect(
        reconciler.address({
          backend: "gsettings",
          key: "org.gnome.desktop.interface:clock-format",
          value: "'24h'",
        }),
      ).toBe("gsettings:org.gnome.desktop.interface:clock-format");
      expect(
        reconciler.address({ backend: "dconf", key: "/test/mypath", value: "['a', 'b']" }),
      ).toBe("dconf:/test/mypath");
    }),
);

it.effect("Setting reconciler observe: undefined when the backend reports the key absent", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeSettingReconciler;
    const observed = yield* reconciler.observe(
      { backend: "dconf", key: "/test/myuint", value: "uint32 5" },
      // Real captured `dconf read` output for a genuinely unset path: zero
      // bytes on stdout.
      planCtx(fakeExec("")),
    );
    expect(observed).toBeUndefined();
  }),
);

it.effect(
  "Setting reconciler observe: the live GVariant text once the backend reports a value",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeSettingReconciler;
      const observed = yield* reconciler.observe(
        { backend: "gsettings", key: "org.gnome.desktop.interface:clock-format", value: "'24h'" },
        planCtx(fakeExec("'24h'\n")),
      );
      expect(observed).toEqual({
        backend: "gsettings",
        key: "org.gnome.desktop.interface:clock-format",
        value: "'24h'",
      });
    }),
);

it.effect("Setting reconciler matches: true iff backend, key and value are all equal", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeSettingReconciler;
    const desired = {
      backend: "gsettings" as const,
      key: "org.gnome.desktop.interface:clock-format",
      value: "'24h'",
    };
    expect(reconciler.matches(desired, desired)).toBe(true);
    expect(reconciler.matches({ ...desired, value: "'12h'" }, desired)).toBe(false);
    expect(reconciler.matches({ ...desired, backend: "dconf" }, desired)).toBe(false);
  }),
);

it.effect("Setting reconciler apply: writes the value and confirms it by reading it back", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeSettingReconciler;
    const { exec, calls } = statefulExec("'12h'", "'24h'");
    const props = {
      backend: "gsettings" as const,
      key: "org.gnome.desktop.interface:clock-format",
      value: "'24h'",
    };
    const desired = yield* reconciler.desired(props);

    const result = yield* reconciler.apply({ props, observed: undefined, desired }, applyCtx(exec));

    expect(result).toEqual({
      backend: "gsettings",
      key: "org.gnome.desktop.interface:clock-format",
      value: "'24h'",
    });
    expect(calls).toEqual([
      "gsettings set org.gnome.desktop.interface clock-format ''\\''24h'\\'''",
      "gsettings get org.gnome.desktop.interface clock-format",
    ]);
  }),
);

it.effect(
  "Setting reconciler apply: fails loudly when a write reports success but the value never changed " +
    "(gsettings' container-verified silent no-op with no session D-Bus)",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeSettingReconciler;
      const calls: string[] = [];
      const props = {
        backend: "gsettings" as const,
        key: "org.gnome.desktop.interface:clock-format",
        value: "'24h'",
      };
      const desired = yield* reconciler.desired(props);

      // The write exits 0, but every read — including the confirmation read
      // `apply` issues right after — still returns the old value, exactly
      // as `gsettings set` behaves with no reachable session D-Bus.
      const result = yield* Effect.flip(
        reconciler.apply(
          { props, observed: undefined, desired },
          applyCtx(noopWriteExec("'12h'", calls)),
        ),
      );

      expect(result._tag).toBe("SettingWriteNotObserved");
      expect(result).toMatchObject({
        backend: "gsettings",
        key: "org.gnome.desktop.interface:clock-format",
        expected: "'24h'",
        actual: "'12h'",
      });
      // Both the write and the confirmation read actually ran.
      expect(calls.length).toBe(2);
    }),
);

it.effect("Setting reconciler apply: dconf backend writes and confirms an array value", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeSettingReconciler;
    const { exec, calls } = statefulExec(undefined, "['a', 'b']");
    const props = { backend: "dconf" as const, key: "/test/mypath", value: "['a', 'b']" };
    const desired = yield* reconciler.desired(props);

    const result = yield* reconciler.apply({ props, observed: undefined, desired }, applyCtx(exec));

    expect(result).toEqual({ backend: "dconf", key: "/test/mypath", value: "['a', 'b']" });
    expect(calls).toEqual([
      "dconf write /test/mypath '['\\''a'\\'', '\\''b'\\'']'",
      "dconf read /test/mypath",
    ]);
  }),
);
