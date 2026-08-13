import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import type { CommandError } from "alchemy/Command";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

export class BackendParseError extends Data.TaggedError("BackendParseError")<{
  cause: unknown;
}> {
  override get message() {
    return "Failed to parse package manager output.";
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
 */
export interface PackageManagerBackend {
  readonly id: string;
  readonly list: (
    session: ScopedPlanStatusSession,
  ) => Effect.Effect<string[], BackendError>;
  readonly install: (
    name: string,
    session: ScopedPlanStatusSession,
  ) => Effect.Effect<void, BackendError>;
  readonly listRepos?: (
    session: ScopedPlanStatusSession,
  ) => Effect.Effect<string[], BackendError>;
  readonly addRepo?: (
    repo: string,
    session: ScopedPlanStatusSession,
  ) => Effect.Effect<void, BackendError>;
}
