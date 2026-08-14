# Testing contract

The default test command is the hermetic contract:

```sh
npm test
```

It must run on Node 22+ in a restricted sandbox without network access,
loopback sockets, elevated privileges, installed platform CLIs, or writes to a
real home directory. Filesystem tests use scoped temporary directories and
inject machine-wide services such as `Backups`, `MachinePaths`, and
`CommandExecutor`. HTTP tests inject `HttpClient`.

The project does not promise identical behavior on every operating system or
JavaScript runtime. The supported baseline is Node 22+. The default suite runs
on Ubuntu and macOS; Windows currently has a typecheck job plus explicit
Windows-tool verification, not a claim of full default-suite parity. Bun and
Deno remain unsupported unless they receive their own runtime matrix and test
contract.

## Test tiers

- `npm test` — deterministic unit and integration tests; no external machine
  state or network.
- `npm run test:hermetic` — the default suite under an ephemeral home/temp
  root, a `PATH` containing only Node, and a process guard that rejects fetches
  and sockets. This is the CI acceptance check for the default contract.
- `npm run test:live` — explicit tests that exercise real host boundaries such
  as loopback sockets, `/bin/sh`, `ssh-keygen`, or other installed tools. These
  are CI-gated on a compatible runner and are not part of the default suite.

The older boundary suites whose filenames predate the `.live.test.ts` convention
(`dotfiles/Exec.test.ts`, `ssh/Key.test.ts`, and `git/Identity.test.ts`) are
listed explicitly in `vitest.live.config.ts`. Their default-safe parser and
reconciler coverage is kept in sibling tests.
- Deploy-check scripts — disposable end-to-end checks for plan, apply,
  idempotence, drift, and destroy behavior in the documented container or OS.

The Ubuntu CI job also runs the hermetic runner inside `node:22-bookworm` with
`--network=none`, a read-only workspace, no capabilities, a non-root uid, and
only an ephemeral `/tmp` writable. That is the acceptance check for accidental
workspace writes or reliance on the runner's host filesystem, not merely an
environment-variable convention.

Captured command output is a valid fixture when it is taken from the real tool
and the test is about parsing that tool. Host-specific paths, fixed ports,
real `$HOME`, external URLs, current locale/timezone, and privilege are not
valid dependencies of default tests.
