# `@machine-run/system-services`

Reconciles one user-level background service — a launchd agent, a systemd
user unit, or a Homebrew-managed service — against three separate facts:
whether its definition is installed, whether it's enabled to start on its
own, and whether it's running right now.

## Why three facts, not one status

`installed`/`enabled`/`running` are kept apart because real service managers
keep them apart on purpose, not by accident. Homebrew's own `kill` verb exists
specifically to reach `enabled: true, running: false` ("stop now, keep it
registered to launch at login"), and its `run` verb exists to reach
`enabled: false, running: true` — captured live for `systemd-user` too. See
`src/Service.ts`'s doc comment for the full reasoning, and
`@machine-run/runtimes`, which learned the same lesson for `installed`/`active`.

## What it exports

| Export                       | What it's for                                                                |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `Service` (`System.Service`) | One service's installed/enabled/running state, against one of three backends |
| `providers()`                | This package's `Layer`, merged into `@machine-run/machine`'s aggregate       |

Backend ids: `launchd`, `brew-services`, `systemd-user`.

## Example

From `examples/complete-machine/recipes/services.ts`:

```ts
import * as SystemServices from "@machine-run/system-services";

// launchd converges whether the job is loaded/running; the plist itself is
// written elsewhere, by Machine.File.
yield *
  SystemServices.Service("backup-agent", {
    backend: "launchd",
    name: "com.example.backup-agent",
  });

// Registered to launch at login, but deliberately not started now.
yield *
  SystemServices.Service("transmission-daemon", {
    backend: "brew-services",
    name: "transmission-cli",
    running: false,
  });

yield *
  SystemServices.Service("sync-daemon", {
    backend: "systemd-user",
    name: "syncthing.service",
  });
```

## Verification status

Per [docs/MAP.md](../../docs/MAP.md) §4: `launchd` and `brew-services` are
verified read-only against real state on a real machine (`launchctl list`,
`brew services info --json`). `systemd-user` (`~`) was verified against a
genuinely booted `systemd --user` instance in a container — a real check, not
just documentation — for every command except `enable`/`disable` themselves,
which were blocked by an unrelated sandbox restriction in that session rather
than a code problem; see `backends/linux/SystemdUser.ts`'s doc comment for the
transcript. `brew-services` on Linux (where it wraps `systemd --user` instead
of `launchctl`) is unverified — nobody has run Homebrew-on-Linux in a
container yet.

**User-level services only, by deliberate design.** launchd's system domain,
plain `systemctl` (no `--user`), and `sudo brew services` all run as root and
start before login — a different privilege boundary no other resource in this
repo crosses. This is a recorded scope decision, not an oversight; see
[TASKS.md](./TASKS.md)'s "Scope decision" section for the reasoning behind not
bolting a `sudo: boolean` onto this resource.

## What it deliberately does not do

- **Conservative `unapply`.** Under an explicit
  `RemovalPolicy: "destroy"`, this resource disables and stops the
  service, but never removes its definition. The default remains `retain`,
  so deleting a recipe line does not stop a service unless the operator opts
  into that side effect.
- **Does not touch launchd's persistent enable/disable override**
  (`launchctl enable`/`disable`, distinct from "currently loaded"). A recipe
  that hits a job carrying that override gets an honest `CommandError` from a
  failed `load`, not a silent no-op — but diagnosing why still requires
  reading `launchctl print-disabled` by hand.
- **Cannot reach `enabled: false, running: true` under launchd** — nothing
  runs under launchd's supervision without being loaded, so that specific
  combination surfaces whatever real command fails first rather than
  converging.

See [TASKS.md](./TASKS.md) for the rest.
