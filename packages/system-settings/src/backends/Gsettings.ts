import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import { type SettingsBackend, SettingKeyInvalid } from "../Backend.ts";

/**
 * `schema-id:key-name`, e.g. `"org.gnome.desktop.interface:clock-format"`.
 *
 * A GSettings schema id is a reverse-DNS-style dotted name and a key name is
 * hyphenated — neither ever contains a colon — so splitting on the first `:`
 * is unambiguous. Relocatable schemas (which need a third, path, component)
 * are not supported; see `docs/settings-notes.md`.
 */
const KEY_PATTERN = /^([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+):([A-Za-z0-9-]+)$/;

const EXPECTED = '"schema-id:key-name", e.g. "org.gnome.desktop.interface:clock-format"';

const parseKey = (
  key: string,
): Effect.Effect<{ schema: string; name: string }, SettingKeyInvalid> => {
  const match = KEY_PATTERN.exec(key);
  if (!match) {
    return Effect.fail(new SettingKeyInvalid({ backend: "gsettings", key, expected: EXPECTED }));
  }
  return Effect.succeed({ schema: match[1]!, name: match[2]! });
};

/**
 * GNOME's GSettings, via the `gsettings` CLI.
 *
 * Verified in an `ubuntu:24.04` container (see `docs/settings-notes.md` for
 * the exact commands and output): a bare Ubuntu image ships `gsettings` with
 * no schemas at all ("No schemas installed") until `gsettings-desktop-schemas`
 * is installed, at which point `get`/`set`/`reset` behave exactly as
 * documented — with one sharp edge, below.
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
export const GsettingsBackend: SettingsBackend = {
  id: "gsettings",

  read: (key, exec) =>
    parseKey(key).pipe(
      Effect.flatMap(({ schema, name }) =>
        exec({ command: Sh.sh("gsettings", "get", schema, name), shell: true }).pipe(
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

  write: (key, value, exec) =>
    parseKey(key).pipe(
      Effect.flatMap(({ schema, name }) =>
        exec({ command: Sh.sh("gsettings", "set", schema, name, value), shell: true }),
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
   * genuinely restores the schema default (`'12h'` → back to `'24h'`).
   */
  reset: (key, exec) =>
    parseKey(key).pipe(
      Effect.flatMap(({ schema, name }) =>
        exec({ command: Sh.sh("gsettings", "reset", schema, name), shell: true }),
      ),
      Effect.asVoid,
    ),
};
