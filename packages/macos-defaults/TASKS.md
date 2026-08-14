# `@machine-run/macos-defaults` — backlog

`MacOS.Default`, carrying full property-list values via XML.

- [ ] **`-array-add` / `-dict-add` semantics.** These converge toward a
      _superset_ rather than toward equality, so `matches` becomes "contains"
      and the reconciler contract genuinely differs. Needs an explicit `mode`
      prop rather than a silent merge.
- [ ] **Byhost preferences** (`defaults -currentHost`) are a separate axis and
      currently unreachable.
- [ ] **Generalise to `System.Setting`.** `@machine-run/system-settings` now
      covers `gsettings`/`dconf` as `System.Setting` backends, container-verified
      (`docs/notes/settings-notes.md`), but macOS was deliberately left out —
      folding `MacOS.Default` in means widening `SettingProps.value` into a
      union keyed by backend. This package becomes a thin alias once that
      happens; the Windows registry is still unimplemented on either side.
- [ ] **The rest of macOS.** Dock items, login items, `ComputerName`/`HostName`,
      `hidutil` keyboard remaps, `pmset`, screenshot location, firewall. Each
      needs its own verified read path — several are not `defaults` at all.
