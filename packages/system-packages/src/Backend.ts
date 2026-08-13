import type { CommandError } from "alchemy/Command";
import type { Exec } from "@machine-run/engine";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

export class BackendParseError extends Data.TaggedError("BackendParseError")<{
  manager: string;
  cause: unknown;
}> {
  override get message() {
    return `Could not parse ${this.manager}'s output. This usually means the CLI's output format changed, or it printed a warning where machine-run expected only data.`;
  }
}

export type BackendError = CommandError | BackendParseError;

/**
 * The shared shape every package manager backend implements. This is the
 * one atomic seam in the whole system: {@link Package} and {@link Repo} are
 * generic resources that know nothing about brew/apt/dnf/pacman/cargo/npm
 * specifically — they just call whichever backend's `list`/`install` (and
 * optionally `listRepos`/`addRepo`) the caller selected. Adding a new
 * package manager means writing one small backend module, never touching
 * the resources themselves.
 *
 * Every method takes an {@link Exec} — the reconciler's own command-running
 * capability, already bound to whichever session belongs to the current
 * phase (silent while planning, live while applying; see
 * `@machine-run/engine`'s `Reconciler.ts`). A backend never sees a session or
 * a `CommandExecutor` itself, and so cannot run a command outside the
 * reconciler's own bookkeeping.
 */
export interface PackageManagerBackend {
  readonly id: string;
  readonly list: (exec: Exec) => Effect.Effect<string[], BackendError>;
  readonly install: (name: string, exec: Exec) => Effect.Effect<void, BackendError>;
  readonly listRepos?: (exec: Exec) => Effect.Effect<string[], BackendError>;
  readonly addRepo?: (repo: string, exec: Exec) => Effect.Effect<void, BackendError>;
}
