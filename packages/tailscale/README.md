# `@machine-run/tailscale`

Reconciles one thing: whether this machine is on the tailnet, authenticated
and running. A single resource wrapping the `tailscale` CLI directly — not a
pluggable backend seam like `secrets` or `system-packages`.

## What it exports

| Export                                   | What it's for                                                                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `Tailscale.Connection` (`Connection.ts`) | Tailnet membership: connects (`tailscale up`) if not already on the tailnet, updates the advertised hostname (`tailscale set`) if it is |

## Example

From `examples/complete-machine/recipes/network.ts`:

```ts
import * as Tailscale from "@machine-run/tailscale";

// The auth key is a reference, never a literal — the same rule as
// Machine.SecretFile, for the same reason.
yield *
  Tailscale.TailscaleConnection("tailnet", {
    authKey: { _tag: "OnePassword", vault: "Personal", item: "Tailscale", field: "authkey" },
    hostname: "complete-machine",
  });
```

`authKey` is a `@machine-run/secrets` `SecretSource` — the same reference
seam `Machine.SecretFile` uses, resolved only at apply time via `readSecret`
and passed to the `tailscale up` process through `env` as `Redacted`, never
interpolated into the command string.

## Verification status

**Nothing here has ever joined a real tailnet.** `observe` decodes `tailscale
status --json`, but the decoder was written from documentation and has never
seen output from a connected daemon — the exact shape of `BackendState` and
`Self.HostName` is unconfirmed (see `Connection.ts`'s own doc comment).
`tailscale up` with a real auth key has never run, so none of the interesting
failure modes — an expired key, a key whose ACL tags don't permit the
requested hostname, a machine already joined to a _different_ tailnet — has
been exercised. This package also depends on `@machine-run/secrets`, itself
the least-verified seam in the repo, so the auth-key path is unverified twice
over (see [TASKS.md](./TASKS.md)'s "Dependency note" and
[../../docs/MAP.md](../../docs/MAP.md) §4).

## What it deliberately does not do

- **No `unapply`.** Not implemented, and this package's own
  [TASKS.md](./TASKS.md) argues it should probably stay that way: logging a
  machine out of its tailnet as a side effect of deleting a line from a recipe
  could cut the operator's own remote access to that machine. `TASKS.md`
  records this as a considered non-goal rather than a settled fact stated in
  the resource itself — worth reading before assuming it's permanent.
- **Only membership is modelled.** Flags like `--advertise-exit-node`,
  `--advertise-routes`, `--accept-routes`, `--ssh`, `--shields-up`, and
  MagicDNS are each a real candidate prop (each is also a field in the status
  JSON), but none is wired up — see [TASKS.md](./TASKS.md)'s "Coverage"
  section.
- **Doesn't notice OS hostname drift.** `hostname` defaults to the OS
  hostname at `desired`-computation time; if the OS hostname changes later,
  the tailnet name doesn't follow, and `matches` only ever compares against
  the prop, never re-derives the current OS hostname.

See [TASKS.md](./TASKS.md) for the rest.
