import * as SystemSettings from "@machine-run/system-settings";
import * as Effect from "effect/Effect";

/**
 * `System.Setting` — the Linux desktop equivalent of the macOS defaults domain.
 *
 * `value` is GVariant text and must be the *canonical* spelling, meaning the
 * exact form `gsettings get` / `dconf read` print back. Both writers accept
 * looser input (an unquoted `24h` for a string key, a missing space after a
 * comma in an array), but only ever print one form, and `matches` compares
 * against a live read — so a loosely spelled value applies once and then
 * reports drift forever. Copy it from a real read rather than writing it from
 * memory.
 *
 * Only meaningful on a Linux desktop — omit this recipe elsewhere.
 */
export const linux = Effect.gen(function* () {
  // `gsettings` addresses as `schema-id:key-name`. Note the quotes inside the
  // value: a GVariant string carries them, and dropping them is the mistake
  // above.
  yield* SystemSettings.Setting("clock-format", {
    backend: "gsettings",
    key: "org.gnome.desktop.interface:clock-format",
    value: "'24h'",
  });

  yield* SystemSettings.Setting("color-scheme", {
    backend: "gsettings",
    key: "org.gnome.desktop.interface:color-scheme",
    value: "'prefer-dark'",
  });

  // An array value, spelled the way a read prints it.
  yield* SystemSettings.Setting("close-window-binding", {
    backend: "gsettings",
    key: "org.gnome.desktop.wm.keybindings:close",
    value: "['<Super>q']",
  });

  // `dconf` addresses by absolute path, and reaches keys with no schema —
  // which is also why it has no validation to catch a typo for you.
  yield* SystemSettings.Setting("terminal-audible-bell", {
    backend: "dconf",
    key: "/org/gnome/desktop/interface/enable-animations",
    value: "false",
  });
});
