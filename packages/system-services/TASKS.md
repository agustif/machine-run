# `@machine-run/system-services` — backlog

`System.Service` over a `ServiceBackend` seam — `launchd`, `systemd-user`,
`brew-services`. User-level services only; see below for why system-level is
a separate decision, not an oversight.

## Scope decision: system-level services are out of scope

`launchd`'s system domain (`/Library/LaunchDaemons`), plain `systemctl` (no
`--user`, `/etc/systemd/system`) and `sudo brew services` all manage services
that start before any user logs in and run as root. That is a different
privilege boundary from everything else this resource does (no other
`machine-run` resource needs root), and a different failure mode: a broken
system daemon can make a machine fail to boot, where a broken user agent just
fails to start for one person. Bolting a `sudo: boolean` prop onto this
resource would quietly cross that boundary inside what looks like an
ordinary, safe-by-default reconciler. This needs its own explicit decision
(a separate resource kind? a separate prop with its own, louder guardrails?)
rather than an incidental widening here.

## Real gaps, in the order they'd bite

- [ ] **launchd's persistent enable/disable override is untouched.**
      `enabled` here means "currently loaded" (`launchctl list <label>`
      succeeds), not launchd's own persistent override
      (`launchctl enable`/`disable`, inspectable with `launchctl
print-disabled`), which survives unload/reboot and can make a future
      `load` fail outright. Real example from this machine:
      `launchctl print-disabled gui/501` lists several real services with
      that override set. A `System.Service` recipe that asks for
      `enabled: true` against a job carrying that override will get an
      honest `CommandError` from a failed `load` — not a silent no-op — but
      diagnosing _why_ requires reading `print-disabled` by hand today.
      Worth a fourth boolean, or at least a mention in the error path, once
      there's a real recipe that hits it.

- [ ] **`systemd-user`'s `enable`/`disable` were never executed**, only
      documented (`man7.org/linux/man-pages/man1/systemctl.1.html`) — every
      other command in that backend (`is-enabled`, `is-active`, `start`,
      `stop`) _was_ run for real against a genuinely booted `systemd --user`
      instance in a container (see `backends/linux/SystemdUser.ts`'s doc
      comment for the exact transcript). The gap is narrow and specific:
      re-run `converge` end-to-end in the same container setup once nothing
      in the sandbox blocks a command containing the word "enable".

- [ ] **`brew-services` on Linux is unverified.** `brew services` wraps
      `systemctl --user` there instead of `launchctl` (confirmed by reading
      its own `--help` banner and `services/system.rb`), so it should work
      unmodified — but nobody has installed Homebrew-on-Linux in a container
      and actually run it. `backends/macos/BrewServices.ts` is grouped under
      `backends/macos/` for exactly this reason: that's where it was
      verified, not a claim about where it runs.

- [ ] **The `(enabled: true, running: false)` recipe for `brew-services`
      briefly starts the service.** Reaching that state from a
      never-registered formula requires `start` (which runs it) followed by
      `kill` (which stops it) — see `backends/macos/BrewServices.ts`'s doc
      comment. A service with real side effects on start (binding a port,
      writing a lock file) will briefly exhibit them. Homebrew's own CLI has
      no single verb for "register without running", so this is a genuine
      tool limitation, not a bug in this backend — but it's worth flagging
      to anyone using this on a service where a few seconds of runtime
      matters.

- [ ] **launchd's `enabled: false, running: true` cannot be reached.**
      Nothing can run under launchd's supervision without also being
      loaded, so this specific combination surfaces whatever real
      `launchctl` command fails first rather than converging. No other
      combination has this problem. Worth deciding whether `Service.ts`
      should reject that combination early with a typed error instead of
      letting a real command fail — currently it does the latter.

- [ ] **No `unapply`.** Same conservative default as 19 of the other 22
      resource kinds in this repo — only `Shell.Login`, `Git.Maintenance` and
      `System.Setting` have one. Disabling and stopping a service someone
      else may depend on is not obviously the right response to a recipe
      line being removed. `brew services stop`/`launchctl unload`/
      `systemctl --user disable` are all real, honest reversals a future
      `unapply` could use.

## Smaller, lower-priority

- [ ] **`installed` is observed but never asserted.** `matches` doesn't
      compare it (see `Service.ts`'s doc comment for why), so there is
      currently no way to write a recipe that says "verify this service's
      definition file was actually removed by an uninstall". Nothing needs
      this yet.
- [ ] **No test fixture for a `launchctl list` job that ran and exited
      non-zero.** `LastExitStatus` is real, captured, present in every
      fixture here — but nothing currently reads it. It doesn't affect
      `enabled`/`running`, but a future `Service.State` could surface it as
      diagnostic information.
