# `@machine-run/system-settings`

Reconciles one Linux desktop setting — a `gsettings` schema key or a `dconf`
path — the Linux equivalent of macOS's `defaults` domain
(`@machine-run/macos-defaults`).

## What it exports

| Export                       | What it's for                                 |
| ---------------------------- | --------------------------------------------- |
| `Setting` (`System.Setting`) | One `gsettings`/`dconf` key, as GVariant text |
| `providers()`                | This package's `Layer`                        |

`SettingProps` is a tagged union — `Gsettings { schema, key }`,
`GsettingsRelocatable { schema, path, key }`, `Dconf { path }` — so a value
shaped for one addressing scheme can't be handed to the other backend.

## Example

From `examples/complete-machine/recipes/linux.ts`:

```ts
import * as SystemSettings from "@machine-run/system-settings";

yield *
  SystemSettings.Setting("clock-format", {
    _tag: "Gsettings",
    schema: "org.gnome.desktop.interface",
    key: "clock-format",
    value: "'24h'", // GVariant string — the quotes are part of the value
  });

// dconf addresses by absolute path and reaches keys with no schema at all.
yield *
  SystemSettings.Setting("terminal-audible-bell", {
    _tag: "Dconf",
    path: "/org/gnome/desktop/interface/enable-animations",
    value: "false",
  });
```

`value` must be the exact canonical spelling `gsettings get`/`dconf read`
print back — both writers accept looser input, but `matches` compares against
a live read, so a loosely-spelled value applies once and then reports drift
forever. Copy it from a real read, don't write it from memory.

## Verification status

Both backends (`gsettings`, `dconf`) are `✓` — verified in a container per
[docs/MAP.md](../../docs/MAP.md) §4. That verification found the single most
important fact about this package: **`gsettings set` exits 0 while doing
nothing** when there's no session D-Bus (a headless machine, a container, a
non-interactive SSH session). `SettingWriteNotObserved` (`Setting.ts`) re-reads
every write and raises a typed error naming the D-Bus root cause the moment an
apply silently no-ops, rather than letting a headless run report success and
drift forever. `dconf` writes its database directly and doesn't need the bus —
making it the _more_ reliable backend headlessly, which inverts the intuition
that schema-validated `gsettings` is the safer default. Verification has so
far only run in containers, never against a real GNOME session — the values a
live desktop writes back may be spelled differently from what a headless
`dconf read` prints.

## What it deliberately does not do

- **Does implement `unapply`** — worth calling out because it's rare in this
  repo (see [../../docs/MAP.md](../../docs/MAP.md) §5): `unapply` calls each
  backend's `reset` (`gsettings reset` / `dconf reset`) and verifies that a
  known silent no-op was not reported as success. It deliberately does not
  require the post-reset value to differ: a schema default may already equal
  the value this resource recorded. No Windows registry backend, and no plan
  to fold `MacOS.Default` into this seam as a backend — property-list values
  are structured, this seam's `value` is GVariant text, a real mismatch not
  just an omission. See [TASKS.md](./TASKS.md).

See [TASKS.md](./TASKS.md) for the rest, including relocatable-schema
addressing and the still-open Windows registry gap.
