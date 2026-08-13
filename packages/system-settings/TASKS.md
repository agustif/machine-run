# `@machine-run/system-settings` — backlog

`System.Setting` over a `SettingsBackend` seam — `gsettings` and `dconf` today.

Both backends are verified in a container, including the finding that
**`gsettings set` exits 0 while doing nothing** with no session D-Bus
(`docs/notes/settings-notes.md`). That is the single most important fact about
this package: the tool reports success for a write that did not happen.

## The unfinished half of that finding

- [ ] **Detect the missing session bus and fail loudly.** Knowing `gsettings set`
      lies is not the same as handling it. Today a headless machine gets a
      successful-looking apply, then reports drift forever on the next plan —
      the worst of both, because the operator sees a converged deploy and a dirty
      plan with no explanation. `observe` should raise a typed error when
      `DBUS_SESSION_BUS_ADDRESS` is absent rather than let `apply` no-op.
- [ ] **Consider `dconf` as the fallback**, since it writes the database
      directly and does not need the bus. That makes it the _more_ reliable
      backend headless, which inverts the intuition that `gsettings` (schema-
      validated) is the safer default.

## Coverage

- [ ] **Windows registry backend.** V1-PLAN's design for `System.Setting` was
      explicitly `defaults` / `gsettings` / `dconf` / registry, and the registry
      is the missing quarter. It is also the one that does not fit: registry
      values are typed (`REG_DWORD`, `REG_SZ`, `REG_MULTI_SZ`) where this seam's
      `value` is a single canonical text form. Decide whether the seam widens or
      whether Windows gets its own resource.
- [ ] **Should `MacOS.Default` become a backend of this seam?** V1-PLAN proposed
      exactly that — `MacOS.Default` as a thin alias over `System.Setting`. It
      was not done, and the reason is real: property-list values are structured
      (arrays, dicts, data) while `System.Setting`'s `value` is GVariant _text_.
      Two resources for "one setting" is a genuine inconsistency though, and it
      is one of the eight naming conventions flagged in
      [docs/TASKS.md](../../docs/TASKS.md).
- [ ] **`gsettings reset` as `unapply`.** Both backends have a real revert
      (`gsettings reset`, `dconf reset`), which makes this one of the few
      packages that could honestly implement `unapply` — unlike uninstalling a
      package. Worth doing as a second worked example alongside `Shell.Login`.

## Verification gaps

- [ ] **Relocatable schemas.** `gsettings` supports `schema:path` addressing for
      relocatable schemas (per-profile terminal settings being the common case),
      and the current `schema-id:key-name` addressing cannot express it.
- [ ] **A real GNOME session**, not a container. Everything verified so far ran
      without a desktop; the values a live session writes back may be spelled
      differently from what a headless `dconf read` prints.
