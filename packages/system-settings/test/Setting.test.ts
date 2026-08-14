import type { ApplyContext, Exec, ObserveContext } from "@machine-run/engine";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  makeSettingReconciler,
  type SettingProps,
  type SettingState,
} from "../src/Setting.ts";

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

/**
 * A command runner where a `reset` genuinely changes the live value on the
 * next read — unlike `noopWriteExec`, below. `afterReset` is exactly what a
 * real `gsettings reset`/`dconf reset` leaves `read` returning afterward: the
 * schema default for gsettings (there is no "unset" gsettings state), or the
 * empty string for dconf (parsed to `undefined` by `DconfBackend.read`'s own
 * "zero bytes means absent" collapse — see `backends/Dconf.ts`).
 */
const resettingExec =
  (afterReset: string, calls: string[]): Exec =>
  (props) => {
    calls.push(props.command);
    if (props.command.startsWith("gsettings reset") || props.command.startsWith("dconf reset")) {
      return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
    }
    return Effect.succeed({ exitCode: 0, stdout: afterReset, stderr: "" });
  };

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
  "Setting reconciler address is backend:schema:key / backend:path, so two Settings on the same key contend",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeSettingReconciler;
      expect(
        reconciler.address({
          _tag: "Gsettings",
          schema: "org.gnome.desktop.interface",
          key: "clock-format",
          value: "'24h'",
        }),
      ).toBe("gsettings:org.gnome.desktop.interface:clock-format");
      expect(
        reconciler.address({
          _tag: "GsettingsRelocatable",
          schema: "org.example.relocatable",
          path: "/org/example/testpath1/",
          key: "greeting",
          value: "'hi'",
        }),
      ).toBe("gsettings:org.example.relocatable:/org/example/testpath1/:greeting");
      expect(reconciler.address({ _tag: "Dconf", path: "/test/mypath", value: "['a', 'b']" })).toBe(
        "dconf:/test/mypath",
      );
    }),
);

it.effect("Setting reconciler observe: none when the backend reports the key absent", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeSettingReconciler;
    const observed = yield* reconciler.observe(
      { _tag: "Dconf", path: "/test/myuint", value: "uint32 5" },
      // Real captured `dconf read` output for a genuinely unset path: zero
      // bytes on stdout.
      planCtx(fakeExec("")),
    );
    expect(observed).toStrictEqual(Option.none());
  }),
);

it.effect(
  "Setting reconciler observe: the live GVariant text once the backend reports a value",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeSettingReconciler;
      const observed = yield* reconciler.observe(
        {
          _tag: "Gsettings",
          schema: "org.gnome.desktop.interface",
          key: "clock-format",
          value: "'24h'",
        },
        planCtx(fakeExec("'24h'\n")),
      );
      expect(observed).toStrictEqual(
        Option.some({
          variant: "Gsettings",
          schema: "org.gnome.desktop.interface",
          key: "clock-format",
          value: "'24h'",
        }),
      );
    }),
);

it.effect("Setting reconciler observe: a relocatable schema reports schema/path/key together", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeSettingReconciler;
    const observed = yield* reconciler.observe(
      {
        _tag: "GsettingsRelocatable",
        schema: "org.example.relocatable",
        path: "/org/example/testpath1/",
        key: "greeting",
        value: "'hi there'",
      },
      planCtx(fakeExec("'hi there'\n")),
    );
    expect(observed).toStrictEqual(
      Option.some({
        variant: "GsettingsRelocatable",
        schema: "org.example.relocatable",
        path: "/org/example/testpath1/",
        key: "greeting",
        value: "'hi there'",
      }),
    );
  }),
);

it.effect(
  "Setting reconciler matches: true iff variant, schema/path/key and value are all equal",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeSettingReconciler;
      const desired: SettingState = {
        variant: "Gsettings",
        schema: "org.gnome.desktop.interface",
        path: undefined,
        key: "clock-format",
        value: "'24h'",
      };
      expect(reconciler.matches(desired, desired)).toBe(true);
      expect(reconciler.matches({ ...desired, value: "'12h'" }, desired)).toBe(false);
      // A dconf state observed at the identical `key`/`value` text never
      // matches a gsettings desired state — the illegal cross-backend mixup
      // the previous flat `{backend, key, value}` shape made possible.
      expect(
        reconciler.matches(
          { variant: "Dconf", schema: undefined, path: undefined, key: undefined, value: "'24h'" },
          desired,
        ),
      ).toBe(false);
    }),
);

it.effect("Setting reconciler drift: empty exactly when matches is true, naming \"value\"", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeSettingReconciler;
    const desired: SettingState = {
      variant: "Gsettings",
      schema: "org.gnome.desktop.interface",
      path: undefined,
      key: "clock-format",
      value: "'24h'",
    };
    expect(reconciler.matches(desired, desired)).toBe(true);
    expect(reconciler.drift?.(desired, desired)).toEqual([]);

    const changed = { ...desired, value: "'12h'" };
    expect(reconciler.matches(changed, desired)).toBe(false);
    expect(reconciler.drift?.(changed, desired)).toEqual([
      { field: "value", observed: "'12h'", desired: "'24h'" },
    ]);
  }),
);

it.effect(
  "Setting reconciler drift: a GsettingsRelocatable mismatch reports \"path\", a Dconf one does not",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeSettingReconciler;
      const desired: SettingState = {
        variant: "GsettingsRelocatable",
        schema: "org.example.relocatable",
        path: "/org/example/testpath1/",
        key: "greeting",
        value: "'hi'",
      };
      const observed = { ...desired, path: "/org/example/testpath2/" };
      expect(reconciler.matches(observed, desired)).toBe(false);
      expect(reconciler.drift?.(observed, desired)).toEqual([
        { field: "path", observed: "/org/example/testpath2/", desired: "/org/example/testpath1/" },
      ]);

      const dconfDesired: SettingState = {
        variant: "Dconf",
        schema: undefined,
        path: "/test/mypath",
        key: undefined,
        value: "['a', 'b']",
      };
      // A wholly different variant (observed is GsettingsRelocatable, desired
      // is Dconf) is reported via "variant" itself.
      expect(reconciler.drift?.(desired, dconfDesired)?.map((f) => f.field)).toContain("variant");
    }),
);

it.effect("Setting reconciler apply: writes the value and confirms it by reading it back", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeSettingReconciler;
    const { exec, calls } = statefulExec("'12h'", "'24h'");
    const props: SettingProps = {
      _tag: "Gsettings",
      schema: "org.gnome.desktop.interface",
      key: "clock-format",
      value: "'24h'",
    };
    const desired = yield* reconciler.desired(props);

    const result = yield* reconciler.apply({ props, observed: Option.none(), desired }, applyCtx(exec));

    expect(result).toEqual({
      variant: "Gsettings",
      schema: "org.gnome.desktop.interface",
      key: "clock-format",
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
      const props: SettingProps = {
        _tag: "Gsettings",
        schema: "org.gnome.desktop.interface",
        key: "clock-format",
        value: "'24h'",
      };
      const desired = yield* reconciler.desired(props);

      // The write exits 0, but every read — including the confirmation read
      // `apply` issues right after — still returns the old value, exactly
      // as `gsettings set` behaves with no reachable session D-Bus.
      const result = yield* Effect.flip(
        reconciler.apply(
          { props, observed: Option.none(), desired },
          applyCtx(noopWriteExec("'12h'", calls)),
        ),
      );

      expect(result._tag).toBe("SettingWriteNotObserved");
      expect(result).toMatchObject({
        expected: "'24h'",
        actual: "'12h'",
      });
      // The message names the CLI and the schema/key, computed from `props`
      // rather than a stored flat field.
      expect(result.message).toContain("org.gnome.desktop.interface clock-format");
      expect(result.message).toContain("gsettings");
      // Both the write and the confirmation read actually ran.
      expect(calls.length).toBe(2);
    }),
);

it.effect(
  "Setting reconciler unapply: resets the key and confirms the value actually changed",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeSettingReconciler;
      const calls: string[] = [];
      const props: SettingProps = {
        _tag: "Gsettings",
        schema: "org.gnome.desktop.interface",
        key: "clock-format",
        value: "'12h'",
      };
      // recorded is what this resource itself wrote (the persisted `output`
      // from the run that last applied); the fake exec answers every read
      // with the schema default `'24h'`, exactly as a real
      // `dbus-run-session`-backed `gsettings reset` restoring it would.
      const recorded: SettingState = {
        variant: "Gsettings",
        schema: props.schema,
        key: props.key,
        value: "'12h'",
      };

      yield* reconciler.unapply!(
        { props, observed: recorded, recorded },
        applyCtx(resettingExec("'24h'", calls)),
      );

      expect(calls).toEqual([
        "gsettings reset org.gnome.desktop.interface clock-format",
        "gsettings get org.gnome.desktop.interface clock-format",
      ]);
    }),
);

it.effect(
  "Setting reconciler unapply: fails loudly when a reset reports success but the value never " +
    "changed (gsettings' container-verified silent no-op with no session D-Bus, applied to reset)",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeSettingReconciler;
      const calls: string[] = [];
      const props: SettingProps = {
        _tag: "Gsettings",
        schema: "org.gnome.desktop.interface",
        key: "clock-format",
        value: "'12h'",
      };
      const recorded: SettingState = {
        variant: "Gsettings",
        schema: props.schema,
        key: props.key,
        value: "'12h'",
      };

      // Every read — including the confirmation read `unapply` issues right
      // after resetting — still returns the value this resource itself
      // wrote, exactly as `gsettings reset` behaves with no reachable
      // session D-Bus.
      const result = yield* Effect.flip(
        reconciler.unapply!(
          { props, observed: recorded, recorded },
          applyCtx(noopWriteExec("'12h'", calls)),
        ),
      );

      expect(result._tag).toBe("SettingResetNotObserved");
      expect(result).toMatchObject({ unwanted: "'12h'" });
      expect(result.message).toContain("org.gnome.desktop.interface clock-format");
      // Both the reset and the confirmation read actually ran.
      expect(calls.length).toBe(2);
    }),
);

it.effect(
  "Setting reconciler unapply: dconf backend resets and confirms the key is now absent",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeSettingReconciler;
      const props: SettingProps = { _tag: "Dconf", path: "/test/mypath", value: "['a', 'b']" };
      const recorded: SettingState = { variant: "Dconf", path: props.path, value: "['a', 'b']" };

      // A real `dconf reset` followed by `dconf read` on a path with no
      // remaining override prints zero bytes — modelled here via
      // `resettingExec("", ...)`, which `DconfBackend.read` collapses to
      // `undefined` (its own "empty stdout means absent" rule).
      const calls: string[] = [];
      yield* reconciler.unapply!(
        { props, observed: recorded, recorded },
        applyCtx(resettingExec("", calls)),
      );

      expect(calls).toEqual(["dconf reset /test/mypath", "dconf read /test/mypath"]);
    }),
);

it.effect("Setting reconciler apply: dconf backend writes and confirms an array value", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeSettingReconciler;
    const { exec, calls } = statefulExec(undefined, "['a', 'b']");
    const props: SettingProps = { _tag: "Dconf", path: "/test/mypath", value: "['a', 'b']" };
    const desired = yield* reconciler.desired(props);

    const result = yield* reconciler.apply({ props, observed: Option.none(), desired }, applyCtx(exec));

    expect(result).toEqual({ variant: "Dconf", path: "/test/mypath", value: "['a', 'b']" });
    expect(calls).toEqual([
      "dconf write /test/mypath '['\\''a'\\'', '\\''b'\\'']'",
      "dconf read /test/mypath",
    ]);
  }),
);

it.effect(
  "Setting reconciler apply: a relocatable schema writes with the combined `schema:path` argument",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeSettingReconciler;
      const { exec, calls } = statefulExec("'hello'", "'hi there'");
      const props: SettingProps = {
        _tag: "GsettingsRelocatable",
        schema: "org.example.relocatable",
        path: "/org/example/testpath1/",
        key: "greeting",
        value: "'hi there'",
      };
      const desired = yield* reconciler.desired(props);

      const result = yield* reconciler.apply(
        { props, observed: Option.none(), desired },
        applyCtx(exec),
      );

      expect(result).toEqual({
        variant: "GsettingsRelocatable",
        schema: "org.example.relocatable",
        path: "/org/example/testpath1/",
        key: "greeting",
        value: "'hi there'",
      });
      expect(calls).toEqual([
        "gsettings set org.example.relocatable:/org/example/testpath1/ greeting ''\\''hi there'\\'''",
        "gsettings get org.example.relocatable:/org/example/testpath1/ greeting",
      ]);
    }),
);
