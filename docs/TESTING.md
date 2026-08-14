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
JavaScript runtime. The supported baseline is Node 22+; OS-specific behavior
is verified by matching CI runners and explicit live jobs. Bun and Deno remain
unsupported unless they receive their own runtime matrix and test contract.

## Test tiers

- `npm test` — deterministic unit and integration tests; no external machine
  state or network.
- `npm run test:live` — explicit tests that exercise real host boundaries such
  as loopback sockets or installed tools. These are CI-gated on a compatible
  runner and are not part of the default suite.
- Deploy-check scripts — disposable end-to-end checks for plan, apply,
  idempotence, drift, and destroy behavior in the documented container or OS.

Captured command output is a valid fixture when it is taken from the real tool
and the test is about parsing that tool. Host-specific paths, fixed ports,
real `$HOME`, external URLs, current locale/timezone, and privilege are not
valid dependencies of default tests.
