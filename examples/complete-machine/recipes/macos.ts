import * as MacOsDefaults from "@machine-run/macos-defaults";
import * as Effect from "effect/Effect";

/**
 * `MacOS.Default` — the macOS preferences domain.
 *
 * Values are ordinary property-list shapes, so arrays, dictionaries and dates
 * are written directly rather than through a per-type flag. `defaults write
 * -array` and friends exist because the CLI has no other way to express
 * structure from a shell; a typed resource does.
 *
 * The reliable way to author these is to configure the machine by hand once,
 * read the value back with `defaults read <domain> <key>`, and copy what it
 * prints. Guessing a key name produces a resource that applies cleanly and
 * changes nothing.
 *
 * Only meaningful on macOS — omit this recipe entirely on other systems.
 */
export const macos = Effect.gen(function* () {
  yield* MacOsDefaults.MacDefault("dock-autohide", {
    domain: "com.apple.dock",
    key: "autohide",
    value: true,
    restartApp: "Dock",
  });

  yield* MacOsDefaults.MacDefault("dock-tilesize", {
    domain: "com.apple.dock",
    key: "tilesize",
    value: 48,
    restartApp: "Dock",
  });

  // A dictionary value, expressed as one.
  yield* MacOsDefaults.MacDefault("finder-toolbar", {
    domain: "com.apple.finder",
    key: "NSToolbar Configuration Browser",
    value: { "TB Display Mode": 2, "TB Is Shown": 1 },
    restartApp: "Finder",
  });

  // An array value.
  yield* MacOsDefaults.MacDefault("finder-preferred-view", {
    domain: "com.apple.finder",
    key: "FXPreferredViewStyle",
    value: ["Nlsv"],
    restartApp: "Finder",
  });

  // `NSGlobalDomain` is the system-wide domain, spelled exactly this way.
  yield* MacOsDefaults.MacDefault("key-repeat", {
    domain: "NSGlobalDomain",
    key: "KeyRepeat",
    value: 2,
  });
});
