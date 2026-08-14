# `@machine-run/system-settings` — backlog

`System.Setting` over a `SettingsBackend` seam — `gsettings` and `dconf` today.

Both backends are verified in a container, including the finding that
**`gsettings set` exits 0 while doing nothing** with no session D-Bus
(`docs/notes/settings-notes.md`). That is the single most important fact about
this package: the tool reports success for a write that did not happen.

## The unfinished half of that finding

- [x] **Detect the missing session bus and fail loudly.** Re-verified
      (2026-08-14, `docs/notes/settings-notes.md`): this was already handled,
      not still open. `SettingWriteNotObserved` (`Setting.ts`) has re-read
      every `write` since `System.Setting` was first committed, and raises a
      typed error naming the D-Bus root cause the moment an `apply` silently
      no-ops — a headless machine never gets a successful-looking apply
      followed by unexplained drift; it gets a loud, explicit failure on the
      run that tried to write. Deliberately did **not** add an
      `observe`-time `DBUS_SESSION_BUS_ADDRESS` check on top: reads never
      need the bus (verified again this session), and the env var is neither
      necessary (some sessions reach a bus without exporting it) nor
      sufficient (a stale address can be set) as a proxy for "will a write
      commit" — a strictly weaker signal than the read-back check already
      in place. See `docs/notes/settings-notes.md`'s new section for the
      full reasoning and the container evidence.
- [x] **Consider `dconf` as the fallback**, since it writes the database
      directly and does not need the bus. That makes it the _more_ reliable
      backend headless, which inverts the intuition that `gsettings` (schema-
      validated) is the safer default. Now stated explicitly in three places
      a reader will actually hit it: `backends/Dconf.ts`'s doc comment,
      `SettingWriteNotObserved`/`SettingResetNotObserved`'s error messages
      (which recommend switching backends in the moment a headless apply
      actually fails), and `Setting.ts`'s own resource-level doc comment
      (new "Headless machines" section).

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
- [x] **`gsettings reset` as `unapply`.** Implemented (`Setting.ts`): both
      backends grew a `reset` method (`Backend.ts`'s `SettingsBackend`
      interface), and `unapply` calls it, then re-reads to confirm the value
      actually changed away from what this resource wrote — the identical
      read-back discipline `apply` already applied to `write`, since
      container verification (2026-08-14) found `gsettings reset` shares
      `set`'s exact silent no-op with no session bus. Unlike `Shell.Login`,
      no bespoke "previous value" bookkeeping was needed in `SettingState`:
      a gsettings key always has *some* value (its schema default), and
      `reset` is the tool's own way back to it, so there's nothing to
      capture at `apply` time.

## Verification gaps

- [ ] **Relocatable schemas.** `gsettings` supports `schema:path` addressing for
      relocatable schemas (per-profile terminal settings being the common case),
      and the current `schema-id:key-name` addressing cannot express it.
- [ ] **A real GNOME session**, not a container. Everything verified so far ran
      without a desktop; the values a live session writes back may be spelled
      differently from what a headless `dconf read` prints.
