import { type Exec, type Reconciler, toProvider } from "@machine-run/engine";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import {
  type DconfIdentity,
  type GsettingsIdentity,
  type GsettingsRelocatableIdentity,
  type SettingsBackendId,
  type SettingsError,
} from "./Backend.ts";
import { settingsBackends } from "./Store.ts";

const valueField = {
  /**
   * The desired value, as GVariant text — the exact form `gsettings get`/
   * `dconf read` print for it, quotes included for a string:
   * `'24h'`, `true`, `32`, `uint32 5`, `['a', 'b']`, `{'k': 'v'}`.
   *
   * This must be the *canonical* form, not any spelling GVariant's parser
   * would accept. `gsettings set`/`dconf write` tolerate looser input (an
   * unquoted `12h` for a string key, a missing space after a comma in an
   * array), but `get`/`read` only ever print one canonical spelling back —
   * verified in `docs/settings-notes.md` — so a `value` written any other
   * way would apply successfully once and then report drift forever, since
   * `matches` (below) compares this text against what a live read returns.
   * The safest way to get this right is to copy it from an actual
   * `gsettings get`/`dconf read` of a machine already configured the way you
   * want, not to hand-write it from memory.
   */
  value: Schema.String,
};

/**
 * A key in one Linux settings store, addressed with the fields that store's
 * own CLI actually takes — never a single combined string this module has to
 * re-parse and validate.
 *
 * ## Why three cases, not `{ backend, key, value }`
 *
 * The previous shape spelled every store's key as one opaque
 * `Schema.String`, split apart at runtime by each backend's own regex:
 * `"schema-id:key-name"` for `gsettings`, an absolute path for `dconf`. That
 * meant a caller could hand `dconf`'s backend a `gsettings`-shaped string (or
 * vice versa) and the mismatch surfaced only as a `SettingKeyInvalid` at
 * `observe`/`apply` time — the identical "runtime check policing an illegal
 * combination the type system allowed" shape `Runtime.Tool`'s
 * `RuntimeToolMismatch` had (see `@machine-run/runtimes`' `Tool.ts`). Here,
 * `Gsettings`/`GsettingsRelocatable`/`Dconf` each carry exactly the fields
 * their CLI invocation needs, so a `dconf`-shaped `path` can no longer be
 * handed to `gsettings`'s `schema`/`key` fields, or the reverse: there is no
 * shared string for the two grammars to collide over.
 *
 * - **`Gsettings`** — an ordinary (non-relocatable) key: `schema` (a
 *   reverse-DNS-style dotted id, e.g. `"org.gnome.desktop.interface"`) and
 *   `key` (hyphenated, e.g. `"clock-format"`), passed to `gsettings
 *   get/set/reset` as two separate arguments.
 * - **`GsettingsRelocatable`** — a key in a *relocatable* schema (one with no
 *   fixed dconf path built in — per-profile terminal settings are the common
 *   real example), which additionally needs `path`: a dconf-style path that
 *   must both begin and end with `/`. `gsettings` addresses this as one
 *   combined `schema:path` argument (verified directly against a real
 *   relocatable schema in an `ubuntu:24.04` container — see
 *   `Backend.ts`'s `GsettingsRelocatableIdentity` doc comment for the exact
 *   commands and errors). This is the gap the previous `SettingProps.key`
 *   could not express at all — flagged in `TASKS.md` — and is now a real
 *   case, not a follow-up.
 * - **`Dconf`** — a raw `dconf` path (e.g.
 *   `"/org/gnome/desktop/interface/clock-format"`), which must begin *but not
 *   end* with `/` — the opposite trailing-slash rule from
 *   `GsettingsRelocatable`'s `path`, because a dconf *key* path names one
 *   value while a gsettings relocatable *schema* path names a directory
 *   prefix a whole schema's keys live under.
 */
export const SettingProps = Schema.TaggedUnion({
  Gsettings: {
    schema: Schema.String,
    key: Schema.String,
    ...valueField,
  },
  GsettingsRelocatable: {
    schema: Schema.String,
    path: Schema.String,
    key: Schema.String,
    ...valueField,
  },
  Dconf: {
    path: Schema.String,
    ...valueField,
  },
});
export type SettingProps = typeof SettingProps.Type;

const SettingVariantId = Schema.Literals(["Gsettings", "GsettingsRelocatable", "Dconf"]);
type SettingVariantId = typeof SettingVariantId.Type;

/**
 * Unlike {@link SettingProps}, this stays one flat `Schema.Struct` rather
 * than a matching `Schema.TaggedUnion` — tried directly and reverted, not a
 * stylistic choice. Alchemy's `Resource<Type, Props, Attributes>` maps every
 * `Attributes` key through `{ [attr in keyof Attributes]-?: AttrOutput<...> }`
 * (`alchemy/src/Resource.ts`), and that mapped type does not resolve to a
 * plain object when `Attributes` is a union — TypeScript then refuses to let
 * `Setting` extend `Resource<...>` at all ("An interface can only extend an
 * object type ... with statically known members"), independent of whether
 * the union's members share every key. Verified directly against this
 * project's actual `alchemy` version (see `@machine-run/runtimes`' `Tool.ts`
 * for the same finding and a standalone repro), not assumed from the error
 * text. `Props` has no such mapped type (`ResourceLike.Props` is a plain
 * field), which is why *it* could become a `TaggedUnion` and this could not.
 *
 * `variant` (not `_tag`) carries which case this is, so `schema`/`path`/`key`
 * here always describe a state the reconciler itself produced (never a
 * recipe-authored value) — the same reasoning `RuntimeToolState`'s optional
 * `tool` field rests on in `@machine-run/runtimes`.
 */
export const SettingState = Schema.Struct({
  variant: SettingVariantId,
  /** Set for `variant: "Gsettings"`/`"GsettingsRelocatable"`. */
  schema: Schema.optionalKey(Schema.String),
  /** Set for `variant: "GsettingsRelocatable"`/`"Dconf"`. */
  path: Schema.optionalKey(Schema.String),
  /** Set for `variant: "Gsettings"`/`"GsettingsRelocatable"`. */
  key: Schema.optionalKey(Schema.String),
  ...valueField,
});
export type SettingState = typeof SettingState.Type;

/**
 * One key in one Linux settings store — `gsettings`' schema-typed keys
 * (ordinary or relocatable), or a raw `dconf` path. The generalisation of
 * `MacOS.Default` this task set out to build, minus macOS itself: see
 * `docs/settings-notes.md` for why that side stays a separate resource for
 * now rather than a third backend id.
 *
 * The value is always written explicitly, never only when it differs from
 * whatever the store already holds, so the result is reproducible rather
 * than dependent on what a machine happened to start with — same rationale
 * as `MacOS.Default`.
 *
 * ## Headless machines: prefer `dconf`, and why `observe` does not check for
 * a session bus
 *
 * `gsettings set` silently no-ops with no reachable session D-Bus (no desktop
 * session, no `DBUS_SESSION_BUS_ADDRESS` — an SSH session, cron, or a bare
 * container); `dconf write` fails loudly in the identical situation. Neither
 * `read` needs a bus at all — both back ends answered `get`/`read` correctly
 * throughout this package's container verification with no bus reachable, so
 * a headless `observe`/`plan` is not the problem. **Prefer the `dconf`
 * backend on a machine that may run headless** — it is the more reliable
 * choice specifically because it fails instead of lying, the opposite of the
 * usual intuition that schema-validated `gsettings` is the safer default.
 *
 * `observe` deliberately does **not** raise a typed error when
 * `DBUS_SESSION_BUS_ADDRESS` is absent. That was considered and rejected: the
 * env var is neither necessary (some sessions reach a bus through
 * `$XDG_RUNTIME_DIR/bus` autodiscovery without ever exporting it) nor
 * sufficient (a stale or dead bus address can still be set) as a proxy for
 * "will a write actually commit" — and `read`/`get` do not depend on the bus
 * to begin with, so gating `observe` on it would fail plans on machines where
 * nothing is actually wrong. `apply`'s read-back check below is a strictly
 * stronger signal: it does not guess *why* a write might not have committed,
 * it confirms whether it did, which is what actually closes the "successful
 * apply, drift forever" failure mode. `unapply`'s read-back check applies the
 * identical discipline to `reset`. See `docs/notes/settings-notes.md` for the
 * container evidence this decision rests on.
 */
export interface Setting extends Resource<"System.Setting", SettingProps, SettingState> {}

export const Setting = Resource<Setting>("System.Setting");

/** Which CLI a `SettingProps` case is read/written through — `Gsettings` and `GsettingsRelocatable` both go through `gsettings`. */
const backendIdFor = (props: SettingProps): SettingsBackendId =>
  Match.value(props).pipe(
    Match.tagsExhaustive({
      Gsettings: () => "gsettings" as const,
      GsettingsRelocatable: () => "gsettings" as const,
      Dconf: () => "dconf" as const,
    }),
  );

/** A human-readable address for a `SettingProps` case, in the shape its own CLI takes it — used only in error messages, never for dispatch. */
const describe = (props: SettingProps): string =>
  Match.value(props).pipe(
    Match.tagsExhaustive({
      Gsettings: (p) => `${p.schema} ${p.key}`,
      GsettingsRelocatable: (p) => `${p.schema}:${p.path} ${p.key}`,
      Dconf: (p) => p.path,
    }),
  );

const adviceFor = (backend: SettingsBackendId, subject: string): string =>
  backend === "gsettings"
    ? `gsettings can report success while doing nothing when there is no reachable session D-Bus ` +
      `(no desktop session, no DBUS_SESSION_BUS_ADDRESS). Run this against a real login session, ` +
      `or use the "dconf" backend, which fails loudly in the same situation instead of silently no-op'ing.`
    : `Check that the ${backend} CLI is actually installed and reachable, and that "${subject}" ` +
      `is spelled the way this backend expects.`;

/**
 * A write reported success, but reading the key back immediately afterwards
 * still shows the old value.
 *
 * This exists because of a container-verified failure mode that has nothing
 * to do with a wrong value or a missing CLI: `gsettings set` exits `0` even
 * when it silently did nothing, because there was no session D-Bus to commit
 * the change to (no desktop session, no `DBUS_SESSION_BUS_ADDRESS` — exactly
 * the situation a bare SSH session, cron, or a headless container puts a
 * reconciler in). See `backends/Gsettings.ts`'s doc comment for the exact
 * container output. Trusting the write's own exit code would let that
 * silent no-op look like a converged, correct apply.
 *
 * Carries the whole `props` (rather than the previous flat `backend`/`key`)
 * because the identifying fields differ by case — `GsettingsRelocatable` has
 * a `path` `Gsettings` doesn't — and `describe`'s `Match.tagsExhaustive`
 * above is what makes a future fourth case a compile error here rather than
 * a silently-wrong message.
 */
export class SettingWriteNotObserved extends Data.TaggedError("SettingWriteNotObserved")<{
  props: SettingProps;
  expected: string;
  actual: string | undefined;
}> {
  override get message() {
    const backend = backendIdFor(this.props);
    const subject = describe(this.props);
    return (
      `Wrote "${subject}" via ${backend}, but reading it back returned ` +
      `${this.actual === undefined ? "nothing" : `"${this.actual}"`} instead of "${this.expected}". ` +
      adviceFor(backend, subject)
    );
  }
}

/**
 * A `reset` reported success, but reading the key back immediately afterwards
 * still shows the value this resource itself wrote — the identical failure
 * shape `SettingWriteNotObserved` catches for `apply`, applied to `unapply`.
 *
 * Container-verified (see `backends/Gsettings.ts`'s `reset` doc comment):
 * `gsettings reset` shares `gsettings set`'s exact no-session-D-Bus silent
 * no-op. Trusting `reset`'s own exit code would let `unapply` report a
 * successful revert that changed nothing on a headless machine, the same
 * hazard `SettingWriteNotObserved` exists to catch on the way in.
 */
export class SettingResetNotObserved extends Data.TaggedError("SettingResetNotObserved")<{
  props: SettingProps;
  unwanted: string;
}> {
  override get message() {
    const backend = backendIdFor(this.props);
    const subject = describe(this.props);
    return (
      `Reset "${subject}" via ${backend}, but reading it back still returned ` +
      `"${this.unwanted}" — the value this resource itself wrote, unchanged. ` +
      adviceFor(backend, subject)
    );
  }
}

/**
 * Everything the shared `observe`/`desired`/`apply`/`unapply` logic below
 * needs from one case of {@link SettingProps}, built once per call by
 * {@link planFor}'s `Match.tagsExhaustive`. Factoring this out is what keeps
 * `observe`/`apply` themselves case-agnostic — written once, not once per
 * case — while every case-specific detail (which backend, which identity
 * shape, which fields the state case carries) stays behind a closure built
 * in exactly one place. Mirrors `@machine-run/runtimes`' `Tool.ts`'s
 * `ToolPlan`.
 */
interface SettingPlan {
  readonly address: string;
  readonly desiredState: SettingState;
  readonly withValue: (value: string) => SettingState;
  readonly read: (exec: Exec) => Effect.Effect<string | undefined, SettingsError>;
  readonly write: (value: string, exec: Exec) => Effect.Effect<void, SettingsError>;
  readonly reset: (exec: Exec) => Effect.Effect<void, SettingsError>;
}

const planFor = (props: SettingProps): SettingPlan =>
  Match.value(props).pipe(
    Match.tagsExhaustive({
      Gsettings: (p): SettingPlan => {
        const identity: GsettingsIdentity = { _tag: "Gsettings", schema: p.schema, key: p.key };
        return {
          address: `gsettings:${p.schema}:${p.key}`,
          desiredState: { variant: "Gsettings", schema: p.schema, key: p.key, value: p.value },
          withValue: (value) => ({ variant: "Gsettings", schema: p.schema, key: p.key, value }),
          read: (exec) => settingsBackends.gsettings.read(identity, exec),
          write: (value, exec) => settingsBackends.gsettings.write(identity, value, exec),
          reset: (exec) => settingsBackends.gsettings.reset(identity, exec),
        };
      },
      GsettingsRelocatable: (p): SettingPlan => {
        const identity: GsettingsRelocatableIdentity = {
          _tag: "GsettingsRelocatable",
          schema: p.schema,
          path: p.path,
          key: p.key,
        };
        return {
          address: `gsettings:${p.schema}:${p.path}:${p.key}`,
          desiredState: {
            variant: "GsettingsRelocatable",
            schema: p.schema,
            path: p.path,
            key: p.key,
            value: p.value,
          },
          withValue: (value) => ({
            variant: "GsettingsRelocatable",
            schema: p.schema,
            path: p.path,
            key: p.key,
            value,
          }),
          read: (exec) => settingsBackends.gsettings.read(identity, exec),
          write: (value, exec) => settingsBackends.gsettings.write(identity, value, exec),
          reset: (exec) => settingsBackends.gsettings.reset(identity, exec),
        };
      },
      Dconf: (p): SettingPlan => {
        const identity: DconfIdentity = { path: p.path };
        return {
          address: `dconf:${p.path}`,
          desiredState: { variant: "Dconf", path: p.path, value: p.value },
          withValue: (value) => ({ variant: "Dconf", path: p.path, value }),
          read: (exec) => settingsBackends.dconf.read(identity, exec),
          write: (value, exec) => settingsBackends.dconf.write(identity, value, exec),
          reset: (exec) => settingsBackends.dconf.reset(identity, exec),
        };
      },
    }),
  );

/**
 * The provider body, exported separately from `SettingProvider` so a test
 * can build it directly and drive `observe`/`matches`/`apply` without the
 * alchemy engine or a real `CommandExecutor` — see
 * `packages/dotfiles/src/File.ts` for the same pattern.
 */
export const makeSettingReconciler: Effect.Effect<
  Reconciler<
    SettingProps,
    SettingState,
    SettingsError | SettingWriteNotObserved | SettingResetNotObserved
  >
> = Effect.succeed({
  // Unlike `MacOS.Default` (addressed per *domain*, because `defaults`
  // rewrites the whole domain's plist file on every write, so two keys in
  // one domain are two read-modify-write cycles over the same file), a
  // GSettings key or dconf path is its own independently-written value —
  // neither CLI reads-modifies-writes a shared file per schema. So the
  // address is the key itself: two `System.Setting`s that happen to name the
  // same key still serialise against each other, but two different keys
  // (even under the same schema) reconcile in parallel.
  address: (props) => planFor(props).address,

  observe: (props, ctx) => {
    const plan = planFor(props);
    return plan
      .read(ctx.exec)
      .pipe(Effect.map((value) => (value === undefined ? undefined : plan.withValue(value))));
  },

  desired: (props) => Effect.succeed(planFor(props).desiredState),

  matches: (observed, desired) =>
    observed.variant === desired.variant &&
    observed.schema === desired.schema &&
    observed.path === desired.path &&
    observed.key === desired.key &&
    observed.value === desired.value,

  apply: ({ props, desired }, ctx) =>
    Effect.gen(function* () {
      const plan = planFor(props);
      yield* plan.write(props.value, ctx.exec);

      // Re-read rather than trust the write's exit code — see
      // `SettingWriteNotObserved`'s doc comment for the container-verified
      // silent-failure mode this catches.
      const confirmed = yield* plan.read(ctx.exec);
      if (confirmed !== props.value) {
        return yield* Effect.fail(
          new SettingWriteNotObserved({ props, expected: props.value, actual: confirmed }),
        );
      }

      return desired;
    }),

  /**
   * `gsettings reset`/`dconf reset` are real reverts the tools themselves
   * provide — restore the schema default, or remove the override entirely —
   * which is what makes this one of the few resources in this repo able to
   * honestly implement `unapply` at all (see `@machine-run/engine`'s
   * `Reconciler.unapply` doc comment, and `Shell.Login`'s `unapply` for the
   * other worked example). Unlike `Login`, there is nothing to record at
   * `apply` time to restore an exact prior value from: a `gsettings` key
   * always has *some* value (its schema default), and `reset` is precisely
   * the tool-provided way back to it, so there is no bespoke "previous value"
   * bookkeeping to add to `SettingState`.
   *
   * Re-reads after resetting for the same reason `apply` re-reads after
   * writing — see `SettingResetNotObserved`'s doc comment for the
   * container-verified silent no-op this guards against.
   */
  unapply: ({ props, recorded }, ctx) =>
    Effect.gen(function* () {
      const plan = planFor(props);
      yield* plan.reset(ctx.exec);

      const confirmed = yield* plan.read(ctx.exec);
      if (confirmed === recorded.value) {
        return yield* Effect.fail(new SettingResetNotObserved({ props, unwanted: recorded.value }));
      }
    }),
});

export const SettingProvider = () => toProvider(Setting, makeSettingReconciler);
