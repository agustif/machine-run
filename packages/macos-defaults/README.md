# `@machine-run/macos-defaults`

Reconciles one key in one macOS `defaults` domain — the macOS preferences
system System Settings and most apps read from. Values are full property-list
shapes (booleans, numbers, strings, arrays, dictionaries, data), written and
read as XML rather than through `defaults`' scalar flags, which cannot express
structure and silently coerce (`defaults`' shorthand list syntax stores `3` in
`(alpha, 3)` as a string, so a written value never matches what's read back).

## What it exports

| Export                                                    | What it's for                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `MacDefault` (`MacOS.Default`)                            | One `domain`/`key` pair, with a full plist value and an optional app to restart after a write                             |
| `providers()`                                             | This package's `Layer`                                                                                                    |
| `Value.ts` (`PlistValueSchema`, `render`, `canonicalXml`) | The JSON-safe plist value schema and its XML rendering/canonicalisation, so two spellings of the same value compare equal |

## Capturing a value: the only reliable way to write one

Guessing a key name produces a resource that applies cleanly and changes
nothing — plausible-looking keys that don't match what the app actually reads
are the common failure here, not a syntax error. The reliable workflow:

1. Change the setting by hand once, through the real UI (System Settings, the
   app's own preferences).
2. Read it back: `defaults read <domain> <key>` — e.g.
   `defaults read com.apple.dock autohide`.
3. Copy what it prints into `value`, in the JSON-safe shape `PlistValueSchema`
   expects (a plain boolean/number/string for scalars, a plain array or object
   for `<array>`/`<dict>`).
4. If the setting needs to take effect immediately rather than after a login,
   set `restartApp` to the app `defaults` write requires be killed and
   relaunched (`"Dock"`, `"Finder"`) — the reconciler runs `killall` on that
   app after a real write.

This is the workflow `examples/example-machine/alchemy.run.ts`'s own
`dock-autohide` resource refers back to.

## Example

From `examples/complete-machine/recipes/macos.ts`:

```ts
import * as MacOsDefaults from "@machine-run/macos-defaults";

yield *
  MacOsDefaults.MacDefault("dock-autohide", {
    domain: "com.apple.dock",
    key: "autohide",
    value: true,
    restartApp: "Dock",
  });

// A dictionary value, expressed directly rather than through a scalar flag.
yield *
  MacOsDefaults.MacDefault("finder-toolbar", {
    domain: "com.apple.finder",
    key: "NSToolbar Configuration Browser",
    value: { "TB Display Mode": 2, "TB Is Shown": 1 },
    restartApp: "Finder",
  });

// NSGlobalDomain is the system-wide domain, spelled exactly this way.
yield *
  MacOsDefaults.MacDefault("key-repeat", {
    domain: "NSGlobalDomain",
    key: "KeyRepeat",
    value: 2,
  });
```

## Verification status

Read/write against real `defaults` output is exercised in CI's "verify
defaults / mas" job against a real macOS runner (`✓`, per
[docs/MAP.md](../../docs/MAP.md) §7). Every value is written explicitly on
every apply, rather than only when it differs from the factory default, so
the result is reproducible across machines instead of depending on what a
given machine happened to start with.

## What it deliberately does not do

- **No `-array-add`/`-dict-add` merge semantics.** A value always converges to
  exactly what's written, never a superset of what's already there — `matches`
  is equality, not "contains". Tracked in [TASKS.md](./TASKS.md).
- **Does not reach byhost preferences** (`defaults -currentHost`) — a separate
  addressing axis, currently unreachable.
- **Does not cover the rest of macOS configuration** that isn't a `defaults`
  key at all — Dock items, login items, `ComputerName`/`HostName`, keyboard
  remaps via `hidutil`, `pmset`, the firewall. Each needs its own verified read
  path.
- **Cannot automate TCC/privacy permissions.** Apple deliberately does not make
  these scriptable; this is a real ceiling, not a gap in this package.
- **Conservative `unapply`.** The live value is captured before each
  write and restored under an explicit `RemovalPolicy: "destroy"`. Old
  state written before that capture field existed is left untouched because its
  prior value cannot be reconstructed safely.

See [TASKS.md](./TASKS.md) for the rest, including the open question of
generalising this into a `System.Setting` backend alongside `gsettings`/`dconf`.
