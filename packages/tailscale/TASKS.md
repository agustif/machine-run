# `@machine-run/tailscale` — backlog

`Tailscale.Connection` — tailnet membership, with the auth key read through
`@machine-run/secrets`' backend seam rather than held in the recipe.

## Verification

- [ ] **`tailscale status --json`'s real shape.** The decoder was written from
      documentation and has never seen output from a connected daemon. This
      already caused one real bug: `observe` passed the whole
      `{exitCode, stdout, stderr}` object to a decoder expecting `stdout`, so a
      connected daemon always read as absent and `apply`'s already-connected
      branch was dead code. That is fixed, but the _shape_ the decoder expects
      is still unconfirmed.
- [ ] **`tailscale up` with a real auth key.** Nothing here has joined a tailnet.
      The interesting failure modes are all unexercised: an expired key, a key
      whose ACL tags do not permit the requested hostname, and a machine already
      joined to a _different_ tailnet.
- [ ] **The not-installed path.** `tailscale` absent should be a typed error
      distinguishable from "installed but not connected". Verify what the shell
      actually returns for each, since a 127 exit and a daemon-down exit must not
      collapse into one case.

## Coverage

- [ ] **Only membership is modelled.** A machine's tailnet configuration is
      larger and all of it is reconcilable: `--advertise-exit-node`,
      `--advertise-routes`, `--accept-routes`, `--ssh`, `--shields-up`,
      MagicDNS. Each is a flag on `tailscale up`/`set` and also a field in the
      status JSON, so each is a candidate prop rather than a new resource — but
      `tailscale set` is the honest apply path for changing one on an
      already-connected machine, and this package only knows `up`.
- [ ] **`unapply` is absent, and should probably stay absent.** Logging out is a
      real revert, but removing a machine from a tailnet as a side
      effect of deleting a line from a recipe could cut the operator's own access
      to that machine. Worth recording as a deliberate refusal rather than a gap.
- [ ] **Hostname drift.** `hostname` defaults to the OS hostname. If the OS
      hostname later changes, the tailnet name does not follow, and the current
      `matches` cannot see that because it compares against the prop, not the
      machine. Decide whether that is drift.

## Dependency note

- [ ] This package depends on `secrets`, generic over whichever `SecretSource`
      a recipe names for the auth key (`Connection.ts`'s `readSecret`). `env`
      and `pass` have read a real secret against a real backend; `1password`
      and `doppler` still need an authenticated account this repo never
      creates, so an auth key sourced from either is unverified twice over —
      once there, once here against a real tailnet.
