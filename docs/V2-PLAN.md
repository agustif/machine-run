# machine-run → v2

[V1-PLAN.md](./V1-PLAN.md) is the first-principles map of what a machine has.
[MAP.md](./MAP.md) is the inventory: what exists, what's verified, and what's
still only planned.

`plan`, `deploy`, drift detection and `destroy` all work end to end —
`scripts/deploy-check.sh` proves the whole cycle in a container. What's left is
paying down what seventeen packages built faster than they could be
reconciled, plus a first deploy against a real, live machine.

## Priorities

**Naming.** Nine naming conventions across 23 resource kinds — the
`Machine`/`System` split stopped meaning anything once both became
reconcilers. Not release-gating (Alchemy's `Resource(type, { aliases })`
carries pre-rename names, so a rename doesn't break state), but worth
settling. TASKS.md P1.

**Directory props.** Two ways to express a directory — `directoryMode` props
versus `Machine.Directory` — is one too many.

**Verification gaps CI can still close.**
- nu's chdir hook *firing* (registration is verified; firing needs a TTY).
- `tailscale status --json`'s real shape.
- `Git.Signing` end to end — nothing in the repo signs anything yet.

**Usable by someone who is not its author.**
- A license. `UNLICENSED` with no `LICENSE` file blocks any release.
- Validate the `exports` maps resolve for a real non-workspace consumer.
- A `machines-<you>` template repo — the split is the intended usage and
  nothing demonstrates it.

## What v2 is not

More breadth. The next new backend should wait until a real deploy against a
live machine has happened.
