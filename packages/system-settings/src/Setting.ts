import { type Reconciler, toProvider } from "@machine-run/engine";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SettingsBackendId, type SettingsError } from "./Backend.ts";
import { settingsBackend } from "./Store.ts";

export const SettingProps = Schema.Struct({
  /** Which store to read from and write to. */
  backend: SettingsBackendId,
  /**
   * The key, in the backend's own addressing scheme:
   * - `gsettings` — `"schema-id:key-name"`, e.g.
   *   `"org.gnome.desktop.interface:clock-format"`.
   * - `dconf` — an absolute dconf path, e.g.
   *   `"/org/gnome/desktop/interface/clock-format"`.
   */
  key: Schema.String,
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
});

export type SettingProps = typeof SettingProps.Type;

export const SettingState = Schema.Struct({
  backend: SettingsBackendId,
  key: Schema.String,
  value: Schema.String,
});

export type SettingState = typeof SettingState.Type;

/**
 * One key in one Linux settings store — `gsettings`' schema-typed keys, or a
 * raw `dconf` path. The generalisation of `MacOS.Default` this task set out
 * to build, minus macOS itself: see `docs/settings-notes.md` for why that
 * side stays a separate resource for now rather than a third backend id.
 *
 * The value is always written explicitly, never only when it differs from
 * whatever the store already holds, so the result is reproducible rather
 * than dependent on what a machine happened to start with — same rationale
 * as `MacOS.Default`.
 */
export interface Setting extends Resource<"System.Setting", SettingProps, SettingState> {}

export const Setting = Resource<Setting>("System.Setting");

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
 */
export class SettingWriteNotObserved extends Data.TaggedError("SettingWriteNotObserved")<{
  backend: SettingsBackendId;
  key: string;
  expected: string;
  actual: string | undefined;
}> {
  override get message() {
    return (
      `Wrote "${this.key}" via ${this.backend}, but reading it back returned ` +
      `${this.actual === undefined ? "nothing" : `"${this.actual}"`} instead of "${this.expected}". ` +
      (this.backend === "gsettings"
        ? `gsettings can report success while doing nothing when there is no reachable session D-Bus ` +
          `(no desktop session, no DBUS_SESSION_BUS_ADDRESS). Run this against a real login session, ` +
          `or use the "dconf" backend, which fails loudly in the same situation instead of silently no-op'ing.`
        : `Check that the ${this.backend} CLI is actually installed and reachable, and that "${this.key}" ` +
          `is spelled the way this backend expects.`)
    );
  }
}

/**
 * The provider body, exported separately from `SettingProvider` so a test
 * can build it directly and drive `observe`/`matches`/`apply` without the
 * alchemy engine or a real `CommandExecutor` — see
 * `packages/dotfiles/src/File.ts` for the same pattern.
 */
export const makeSettingReconciler: Effect.Effect<
  Reconciler<SettingProps, SettingState, SettingsError | SettingWriteNotObserved>
> = Effect.succeed({
  // Unlike `MacOS.Default` (addressed per *domain*, because `defaults`
  // rewrites the whole domain's plist file on every write, so two keys in
  // one domain are two read-modify-write cycles over the same file), a
  // GSettings key or dconf path is its own independently-written value —
  // neither CLI reads-modifies-writes a shared file per schema. So the
  // address is the key itself: two `System.Setting`s that happen to name the
  // same key still serialise against each other, but two different keys
  // (even under the same schema) reconcile in parallel.
  address: (props) => `${props.backend}:${props.key}`,

  observe: (props, ctx) =>
    settingsBackend(props.backend)
      .read(props.key, ctx.exec)
      .pipe(
        Effect.map((value) =>
          value === undefined ? undefined : { backend: props.backend, key: props.key, value },
        ),
      ),

  desired: (props) =>
    Effect.succeed({ backend: props.backend, key: props.key, value: props.value }),

  matches: (observed, desired) =>
    observed.backend === desired.backend &&
    observed.key === desired.key &&
    observed.value === desired.value,

  apply: ({ props, desired }, ctx) =>
    Effect.gen(function* () {
      const backend = settingsBackend(props.backend);
      yield* backend.write(props.key, props.value, ctx.exec);

      // Re-read rather than trust the write's exit code — see
      // `SettingWriteNotObserved`'s doc comment for the container-verified
      // silent-failure mode this catches.
      const confirmed = yield* backend.read(props.key, ctx.exec);
      if (confirmed !== props.value) {
        return yield* Effect.fail(
          new SettingWriteNotObserved({
            backend: props.backend,
            key: props.key,
            expected: props.value,
            actual: confirmed,
          }),
        );
      }

      return desired;
    }),
});

export const SettingProvider = () => toProvider(Setting, makeSettingReconciler);
