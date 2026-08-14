import type { CommandError } from "alchemy/Command";
import type { Exec } from "@machine-run/engine";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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
 * one atomic seam in the whole system: {@link Package} is a generic resource
 * that knows nothing about brew/apt/dnf/pacman/cargo/npm specifically — it
 * just calls whichever backend's `list`/`install` the caller selected.
 * Adding a new package manager means writing one small backend module,
 * never touching the resource itself.
 *
 * `listRepos`/`addRepo` used to live here too, typed to a plain `string`.
 * They moved to {@link RepoBackend}, generic in the manager-specific shape a
 * repository actually is — see {@link RepoSpec}'s doc comment for why a
 * single opaque `string` could not honestly represent that.
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
}

/**
 * One extra package repository, in whatever shape the manager that owns it
 * actually needs — see each tag's own field(s):
 *
 * - `Brew` — a tap, `owner/name` (`brew tap owner/name`).
 * - `Apt` — a PPA reference exactly as `add-apt-repository` takes it, most
 *   commonly `ppa:owner/name`.
 * - `Dnf` — a COPR project, `owner/project` (`dnf copr enable -y owner/project`).
 * - `Flatpak` — a remote's `name` and, when adding it for the first time,
 *   the bootstrap `location` URL `flatpak remote-add` needs. `location` is
 *   optional because a recipe may only need to *recognise* an already-added
 *   remote by name (see `Repo.ts`'s reconciler `observe`) without ever
 *   adding it itself — but see `backends/linux/Flatpak.ts`'s own doc comment
 *   for the real, container-verified limitation this uncovers: the location
 *   `flatpak remotes` reports back is never the bootstrap URL that was
 *   passed to `remote-add`, so a `Flatpak` repo declared with the bootstrap
 *   form never converges.
 *
 * This exists because a single opaque `repo: string` (the shape this had
 * before) let `{ manager: "dnf", repo: "flathub https://..." }` type-check —
 * a COPR manager paired with a Flatpak-shaped value neither `dnf` nor any
 * other backend could ever have parsed. A tagged union makes that
 * combination unrepresentable: naming a manager and naming its repo are the
 * same act, not two facts kept in sync by hand.
 *
 * `pacman` has no tag here for the same reason it was excluded from this
 * resource's predecessor `RepoManagerId` enum: the AUR has no server-side
 * "extra repo" concept for this to model — see `Repo.ts`'s doc comment.
 *
 * This is a props-and-state schema break from the flat `{ manager, repo }`
 * shape `System.Repo` shipped with previously. That shape never reached a
 * real deployment, so there is no persisted state anywhere to migrate.
 */
export const RepoSpec = Schema.TaggedUnion({
  Brew: { tap: Schema.String },
  Apt: { ppa: Schema.String },
  Dnf: { project: Schema.String },
  Flatpak: { name: Schema.String, location: Schema.optionalKey(Schema.String) },
});
export type RepoSpec = typeof RepoSpec.Type;

export type BrewRepo = Extract<RepoSpec, { _tag: "Brew" }>;
export type AptRepo = Extract<RepoSpec, { _tag: "Apt" }>;
export type DnfRepo = Extract<RepoSpec, { _tag: "Dnf" }>;
export type FlatpakRepo = Extract<RepoSpec, { _tag: "Flatpak" }>;

/**
 * The shared shape every repo-capable package manager backend implements —
 * `Repo.ts`'s own atomic seam, kept separate from {@link PackageManagerBackend}
 * because `Spec` is manager-specific (one member of {@link RepoSpec}) where
 * `list`/`install` operate on a package name, a plain string every manager
 * agrees on. Every manager in {@link RepoSpec} implements both methods —
 * unlike the old optional `listRepos?`/`addRepo?`, there is no manager in
 * this closed set that only partially supports repos, so nothing here needs
 * an "unsupported" escape hatch.
 */
export interface RepoBackend<Spec> {
  readonly listRepos: (exec: Exec) => Effect.Effect<Spec[], BackendError>;
  readonly addRepo: (repo: Spec, exec: Exec) => Effect.Effect<void, BackendError>;
}
