import { services as coreServices } from "@machine-run/core";
import * as Ai from "@machine-run/ai";
import * as Dotfiles from "@machine-run/dotfiles";
import * as Git from "@machine-run/git";
import * as MacOsDefaults from "@machine-run/macos-defaults";
import * as Runtimes from "@machine-run/runtimes";
import * as Secrets from "@machine-run/secrets";
import * as Shell from "@machine-run/shell";
import * as Ssh from "@machine-run/ssh";
import * as SystemPackages from "@machine-run/system-packages";
import * as SystemSettings from "@machine-run/system-settings";
import * as Tailscale from "@machine-run/tailscale";
import { CommandExecutorLive } from "alchemy/Command";
import * as Layer from "effect/Layer";

/**
 * Every `@machine-run/*` resource package's providers, wired together
 * exactly once, so a recipe can provide a single layer instead of
 * hand-assembling one.
 *
 * ## The bug this exists to close
 *
 * A package's `providers()` simply never appearing in a recipe's own
 * `Layer.mergeAll(...)` is a **silent runtime failure**, not a compile
 * error: nothing statically connects "this recipe calls
 * `SystemPackages.packages(...)`" to "therefore `SystemPackages.providers()`
 * must be in this list." Forget one and the first `yield*` of that resource
 * fails at `alchemy plan`/`deploy` time with a bare "service not found," not
 * at `tsc -b` time. This repo hit that exact bug twice before
 * `examples/example-machine/alchemy.run.ts` grew a long warning comment
 * about it — see that file for the version assembled by hand, and for the
 * `Layer.provideMerge` subtleties spelled out in more detail than repeated
 * here. This package is the fix: one layer, covering every resource type
 * this repo defines, so a recipe can never have the gap in the first place.
 *
 * ## What this resolves, and why it must happen exactly once
 *
 * Every resource in `dotfiles`, `macos-defaults`, `secrets`,
 * `system-packages` and `tailscale` is built on `@machine-run/engine`'s
 * `toProvider`, whose generated `read`/`diff`/`reconcile`/`delete`
 * unconditionally resolve `Backups` and `FileLock` from context — even for a
 * resource that never calls `ctx.snapshot` or sets `snapshotBeforeApply`
 * (see `system-packages`' own `Providers.ts` for that same note, scoped to
 * just its two resources). `dotfiles`' file-hashing reconcilers
 * (`Machine.File`, `Machine.ManagedBlock`, and whatever else lands there)
 * additionally resolve `Crypto` via `@machine-run/core`'s `makeSha256`.
 * `Layer.mergeAll` siblings do **not** resolve each other's or their own
 * transitive requirements — each only sees what is threaded in from
 * *outside* via `Layer.provide`/`Layer.provideMerge` — which is why
 * `Core.services()` is piped on once, below, rather than folded into the
 * list of siblings above.
 *
 * That "once" is load-bearing, not stylistic: `FileLock`'s exclusion only
 * holds if every resource draws its lock from the *same* table (see core's
 * docs — the table itself is process-scoped specifically so this can't be
 * gotten wrong by re-building the layer), and `Backups` stamps one directory
 * per run, so two independent instances would produce two backup roots for
 * what should be one reviewable deploy.
 *
 * `Crypto` is included in `Core.services()` for a subtler reason: Alchemy's
 * own `StackServices` supplies `FileSystem`, `Path`, `HttpClient` and
 * `ChildProcessSpawner` to every recipe, but not `Crypto` — hashing isn't
 * something the stack itself needs, so nothing upstream of a recipe would
 * ever provide it. Omitting it here would be exactly the kind of gap this
 * package exists to close: invisible at `tsc -b` time, and only surfacing as
 * a missing-service failure the first time a recipe's plan touches
 * `Machine.File`.
 *
 * `CommandExecutorLive()` is provided once more, on top, for the siblings
 * that need a *shared* `CommandExecutor` (`dotfiles`, `secrets`,
 * `system-packages`, `tailscale` — anything built on `toProvider` that runs
 * commands, plus resources whose reconcilers don't run commands themselves
 * but whose `toProvider`-generated hooks still resolve one unconditionally).
 * `macos-defaults` is the one exception: its own `providers()` already
 * builds and privately provides its own `CommandExecutorLive()` internally
 * (see that package's `Providers.ts`), so the instance provided here never
 * reaches it — `Layer.provide` only satisfies the requirements of the layer
 * it is piped onto, not a private one nested inside a sibling that already
 * closed over its own.
 *
 * Alchemy's own `Command.Exec`/`Build`/`Dev` resources (registered by
 * `alchemy/Command`'s own `providers()`) are deliberately **not** included
 * here: nothing in this repo's own packages uses them, and a recipe that
 * wants that escape hatch can still merge `Command.providers()` itself
 * alongside this one, the same way the example recipe does today.
 *
 * ## Keeping this complete
 *
 * The value of this layer is entirely in its completeness: a package missing
 * from the list below turns back into the silent runtime failure this exists
 * to prevent. Every package that defines a resource belongs here, and adding
 * one is three edits — the `Layer.mergeAll` list, this package's
 * `dependencies`, and its `tsconfig.json` references.
 */
export const providers = () =>
  Layer.mergeAll(
    Ai.providers(),
    Dotfiles.providers(),
    Git.providers(),
    MacOsDefaults.providers(),
    Runtimes.providers(),
    Secrets.providers(),
    Shell.providers(),
    Ssh.providers(),
    SystemPackages.providers(),
    SystemSettings.providers(),
    Tailscale.providers(),
  ).pipe(Layer.provideMerge(coreServices()), Layer.provide(CommandExecutorLive()));
