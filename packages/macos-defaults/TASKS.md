# `@machine-run/macos-defaults` — backlog

`MacOS.Default`, carrying full property-list values via XML.

- [ ] **`-array-add` / `-dict-add` semantics.** These converge toward a
      _superset_ rather than toward equality, so `matches` becomes "contains"
      and the reconciler contract genuinely differs. Needs an explicit `mode`
      prop rather than a silent merge.
- [ ] **Byhost preferences** (`defaults -currentHost`) are a separate axis and
      currently unreachable.
- [ ] **Generalise to `System.Setting`.** `defaults` is one settings backend;
      `gsettings`/`dconf` and the Windows registry are the same shape. This
      package becomes a thin alias. Verify `gsettings` in a container.
- [ ] **The rest of macOS.** Dock items, login items, `ComputerName`/`HostName`,
      `hidutil` keyboard remaps, `pmset`, screenshot location, firewall. Each
      needs its own verified read path — several are not `defaults` at all.
- [ ] **Document what cannot be automated.** TCC/privacy permissions are
      deliberately not scriptable by Apple. Say so explicitly rather than
      leaving it as an unexplained absence.
- [ ] A README describing the capture-from-a-real-`defaults read` workflow,
      which source comments already reference.
