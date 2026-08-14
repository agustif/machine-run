import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import {
  type GsettingsIdentity,
  type GsettingsRelocatableIdentity,
  type SettingsBackend,
  SettingKeyInvalid,
} from "../Backend.ts";

const SCHEMA_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const KEY_NAME_PATTERN = /^[A-Za-z0-9-]+$/;

/** A GSettings schema id is a reverse-DNS-style dotted name — never a bare word, never containing a colon. */
const checkSchema = (schema: string): Effect.Effect<string, SettingKeyInvalid> =>
  SCHEMA_PATTERN.test(schema)
    ? Effect.succeed(schema)
    : Effect.fail(
        new SettingKeyInvalid({
          backend: "gsettings",
          field: "schema",
          value: schema,
          expected: 'a reverse-DNS-style dotted id, e.g. "org.gnome.desktop.interface"',
        }),
      );

/** A GSettings key name is hyphenated — never dotted, never containing a colon. */
const checkKeyName = (key: string): Effect.Effect<string, SettingKeyInvalid> =>
  KEY_NAME_PATTERN.test(key)
    ? Effect.succeed(key)
    : Effect.fail(
        new SettingKeyInvalid({
          backend: "gsettings",
          field: "key",
          value: key,
          expected: 'a hyphenated key name, e.g. "clock-format"',
        }),
      );

/**
 * A relocatable schema's `path` must both begin and end with `/` — verified
 * directly against a real relocatable schema in an `ubuntu:24.04` container
 * (`docs/settings-notes.md`): `gsettings get SCHEMA:PATH KEY` with a `path`
 * missing the leading slash fails with `"Path must begin with a slash (/)"`,
 * and one missing the trailing slash fails with `"Path must end with a
 * slash (/)"` — both exit 1, before ever reaching D-Bus. Checked client-side
 * here for the same reason `DconfBackend.checkPath` (in `backends/Dconf.ts`)
 * checks its own path shape: fail loudly before running anything, per rule
 * 11 in `AGENTS.md`, rather than surfacing gsettings' own client-side error
 * as an opaque non-zero exit.
 */
const checkRelocatablePath = (path: string): Effect.Effect<string, SettingKeyInvalid> =>
  path.startsWith("/") && path.endsWith("/")
    ? Effect.succeed(path)
    : Effect.fail(
        new SettingKeyInvalid({
          backend: "gsettings",
          field: "path",
          value: path,
          expected:
            'an absolute path beginning and ending with "/", e.g. "/org/example/testpath1/"',
        }),
      );

/**
 * The schema argument `gsettings get/set/reset` takes: a bare schema id for
 * an ordinary key, or `schema:path` — one combined argument, colon-joined —
 * for a relocatable one. Built from {@link GsettingsIdentity}/{@link
 * GsettingsRelocatableIdentity} via `Match.tagsExhaustive`, so a third
 * identity shape added to this backend later is a compile error here, not a
 * silently-ignored case.
 */
const schemaArg = (
  identity: GsettingsIdentity | GsettingsRelocatableIdentity,
): Effect.Effect<string, SettingKeyInvalid> =>
  Match.value(identity).pipe(
    Match.tagsExhaustive({
      Gsettings: (i) => checkSchema(i.schema),
      GsettingsRelocatable: (i) =>
        Effect.all([checkSchema(i.schema), checkRelocatablePath(i.path)]).pipe(
          Effect.map(([schema, path]) => `${schema}:${path}`),
        ),
    }),
  );

/**
 * GNOME's GSettings, via the `gsettings` CLI — one backend for both ordinary
 * and relocatable schemas, since both are read/written through the same
 * binary and differ only in the schema argument `schemaArg` builds above.
 *
 * Verified in an `ubuntu:24.04` container (see `docs/settings-notes.md` for
 * the exact commands and output): a bare Ubuntu image ships `gsettings` with
 * no schemas at all ("No schemas installed") until `gsettings-desktop-schemas`
 * is installed, at which point `get`/`set`/`reset` behave exactly as
 * documented — with one sharp edge, below. Relocatable-schema addressing
 * (`SCHEMA:PATH`) was verified separately, directly, against a throwaway
 * relocatable schema compiled into the same container — see
 * `GsettingsRelocatableIdentity`'s doc comment in `Backend.ts` for the exact
 * commands and output, including that the identical silent-no-op-with-no-
 * session-bus hazard below applies to it unchanged.
 *
 * ## `gsettings set` can silently no-op
 *
 * Confirmed in the same container: with no session D-Bus reachable (no
 * `DBUS_SESSION_BUS_ADDRESS`, no X11 `$DISPLAY` to autolaunch one — exactly
 * the situation machine-run runs in under a bare SSH session, cron, or a
 * container), `gsettings set` prints
 * `dconf-WARNING **: failed to commit changes to dconf: Cannot autolaunch
 * D-Bus without X11 $DISPLAY` to stderr **and still exits 0**. The key is
 * left completely unchanged. This is why `Setting.ts`'s `apply` always reads
 * a key back after writing it and fails loudly if the value didn't actually
 * change, rather than trusting this backend's own exit code.
 */
export const GsettingsBackend: SettingsBackend<GsettingsIdentity | GsettingsRelocatableIdentity> = {
  id: "gsettings",

  read: (identity, exec) =>
    Effect.all([schemaArg(identity), checkKeyName(identity.key)]).pipe(
      Effect.flatMap(([schema, key]) =>
        exec({ command: Sh.sh("gsettings", "get", schema, key), shell: true }).pipe(
          Effect.map((result) => result.stdout.trim()),
          // A non-zero exit means the schema isn't installed or the key
          // doesn't exist in it ("No such schema"/"No such key", verified
          // above) — an ordinary state to converge from, the same collapse
          // `MacOS.Default`'s `observe` makes for a missing `defaults`
          // domain/key. A key that exists but was never explicitly set is
          // NOT this case: GSettings always has a schema-provided default,
          // so `get` on such a key exits 0 and returns that default's text.
          Effect.orElseSucceed(() => undefined),
        ),
      ),
    ),

  write: (identity, value, exec) =>
    Effect.all([schemaArg(identity), checkKeyName(identity.key)]).pipe(
      Effect.flatMap(([schema, key]) =>
        exec({ command: Sh.sh("gsettings", "set", schema, key, value), shell: true }),
      ),
      Effect.asVoid,
    ),

  /**
   * Verified in the same `ubuntu:24.04` container, on 2026-08-14, with no
   * session D-Bus reachable: `gsettings reset org.gnome.desktop.interface
   * clock-format` prints the identical `dconf-WARNING **: failed to commit
   * changes to dconf: Cannot autolaunch D-Bus without X11 $DISPLAY` and
   * **exits 0** while the key stays exactly as it was — the same silent
   * no-op `write` has, not a different failure mode `reset` happens to avoid.
   * With a session bus reachable (`dbus-run-session`), `gsettings reset`
   * genuinely restores the schema default (`'12h'` → back to `'24h'`), and
   * the identical revert was verified against a relocatable schema too.
   */
  reset: (identity, exec) =>
    Effect.all([schemaArg(identity), checkKeyName(identity.key)]).pipe(
      Effect.flatMap(([schema, key]) =>
        exec({ command: Sh.sh("gsettings", "reset", schema, key), shell: true }),
      ),
      Effect.asVoid,
    ),
};
