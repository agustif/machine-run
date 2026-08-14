# `@machine-run/core`

The shared vocabulary every other package builds on. No internal dependencies —
every package here depends on `core`, never the reverse (see
[../../docs/MAP.md](../../docs/MAP.md) §2 for the dependency graph). It is not a
resource package: nothing here is an Alchemy `Resource`, and it defines no
`Reconciler`.

## What it exports

| Export                                   | What it's for                                                                                                                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MachinePaths` (`Paths.ts`)              | Expands a leading `~` to an absolute, normalised path, so a recipe can write `~/.zshrc` portably instead of a hard-coded home directory                                                         |
| `Backups`                                | Snapshots a real pre-existing file into one per-run directory under `~/.local/state/machine-run/backups/`, before a resource overwrites content it didn't write                                 |
| `FileLock`                               | A `Semaphore`-backed, process-scoped lock keyed by path, so two resources read-modify-writing the same file (e.g. two git personas in one `~/.gitconfig`) can't interleave                      |
| `Sh` (`Sh.ts`)                           | POSIX (`sh.quote`) and PowerShell (`pwsh`) command quoting for building a command string safely — see rule 9 in [../../AGENTS.md](../../AGENTS.md) on why a template literal is never safe here |
| `hash` (`makeSha256`)                    | A SHA-256 function with `effect/Crypto` already resolved, used by every file-shaped resource to detect content drift                                                                            |
| `Sessions` (`silentSession`)             | A no-op `ScopedPlanStatusSession`, for the resources that must run a read-only command inside `diff`/`read`, which Alchemy gives no session to                                                  |
| `Providers` (`services()`)               | The `Layer` every file-touching package needs: `Backups`, `FileLock`, and `NodeCrypto`, merged and provided once beneath the resource providers                                                 |
| `Command.ts`                             | Re-exports `alchemy/Command`'s `CommandExecutor` types used throughout                                                                                                                          |
| `windows/` (`FilePermissions`, `Icacls`) | A POSIX-mode ↔ Windows ACL translation seam and an `icacls`-output parser — built and unit-tested, but not yet called by any resource (see below)                                               |

## Example

```ts
import { Sh } from "@machine-run/core";

const command = Sh.sh("brew", "install", packageName);
// run with { shell: true } — see AGENTS.md rule 9
```

There is no worked "recipe" example because nothing here is a resource a
recipe calls directly; every resource package pulls these services in through
its own `Providers.ts`.

## Verification status

Pure logic (`MachinePaths.expand`, `Sh` quoting, hashing) is unit-tested
directly. `Backups` and `FileLock` are exercised through the resources built on
`@machine-run/engine`'s `toProvider`, including under a real
`plan` → `deploy` → drift → `destroy` cycle in a container
(`scripts/deploy-check.sh`) for `Machine.File`, `ManagedBlock`, `Directory`,
`Symlink`, `SecretFile`, and `Exec` — see
[../../docs/MAP.md](../../docs/MAP.md).

## What it deliberately does not do

- **No Windows resource wiring yet.** `windows/FilePermissions.ts` and
  `windows/Icacls.ts` exist and are unit-tested
  ([../../docs/notes/windows-permissions.md](../../docs/notes/windows-permissions.md)),
  but no resource's `observe`/`apply` calls either module. Wiring them into
  `Machine.File`/`Directory`/`Download`/`SecretFile` is separate, unstarted
  work — see [TASKS.md](./TASKS.md).
- **No cross-process locking.** `FileLock` is process-scoped: it prevents two
  resources within one `alchemy deploy` from racing, not two concurrent
  `deploy` invocations. See [TASKS.md](./TASKS.md).
- **No backup retention.** Nothing prunes
  `~/.local/state/machine-run/backups/`; a repeatedly-adopted machine
  accumulates run directories forever.

See [TASKS.md](./TASKS.md) for the rest of the backlog, and
[../../docs/MAP.md](../../docs/MAP.md) for how this fits the other packages.
