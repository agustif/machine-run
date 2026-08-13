import * as Layer from "effect/Layer";
import { KeyProvider } from "./Key.ts";
import { KnownHostProvider } from "./KnownHost.ts";

/**
 * Registers `Ssh.Key` and `Ssh.KnownHost`.
 *
 * `sshHost()` composes `@machine-run/dotfiles`' `Machine.ManagedBlock` and so
 * needs nothing registered here — see that package's own `providers()`,
 * which this recipe must also merge in.
 *
 * `toProvider`'s generated `reconcile` unconditionally resolves
 * `CommandExecutor`, `Backups` and `FileLock` — `Ssh.KnownHost` never sets
 * `snapshotBeforeApply` or calls `ctx.snapshot`, and `Ssh.Key` runs commands
 * only through `ctx.exec`. None of those three are provided here: the
 * composing recipe supplies one shared `CommandExecutor` (and
 * `@machine-run/core`'s `services()` for `Backups`/`FileLock`) for every
 * command-shaped resource across every package, the same way
 * `@machine-run/system-settings` and `@machine-run/tailscale` leave them to
 * bubble up rather than each building a private instance — see those
 * packages' own `Providers.ts` for the same note.
 */
export const providers = () => Layer.mergeAll(KeyProvider(), KnownHostProvider());
