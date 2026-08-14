# `@machine-run/system-settings` — backlog

`System.Setting` over a `SettingsBackend` seam — `gsettings` and `dconf` today.

Without a session D-Bus, `gsettings set`/`reset` exit 0 while doing nothing at
all — the single most important fact about this seam when reasoning about a
headless machine (`docs/notes/settings-notes.md`).

## Open work

- [ ] **Windows registry backend.** V1-PLAN's design for `System.Setting` was
      explicitly `defaults` / `gsettings` / `dconf` / registry, and the
      registry is the missing quarter. It's also the one that doesn't fit:
      registry values are typed (`REG_DWORD`, `REG_SZ`, `REG_MULTI_SZ`) where
      this seam's `value` is a single canonical text form. Decide whether
      the seam widens or whether Windows gets its own resource.
- [ ] **Should `MacOS.Default` become a backend of this seam?** V1-PLAN
      proposed exactly that. Not done, and the reason is real:
      property-list values are structured (arrays, dicts, data) while
      `System.Setting`'s `value` is GVariant _text_. Two resources for "one
      setting" is a genuine inconsistency though — see
      [docs/TASKS.md](../../docs/TASKS.md).
- [ ] **A real GNOME session**, not a container. Everything verified so far
      (including the relocatable-schema addressing) ran headless; the
      values a live session writes back may be spelled differently from
      what a headless `dconf read` prints.
