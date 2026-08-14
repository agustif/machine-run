import { type VersionSpec } from "@machine-run/core";
import type { CommandError } from "alchemy/Command";
import type { Exec, ExecutionContext } from "@machine-run/engine";
import * as Boolean from "effect/Boolean";
import type * as Duration from "effect/Duration";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

export class BackendParseError extends Data.TaggedError("BackendParseError")<{
  manager: string;
  cause: unknown;
}> {
  override get message() {
    return `Could not parse ${this.manager}'s output. This usually means the CLI's output format changed, or it printed a warning where machine-run expected only data.`;
  }
}

/**
 * Raised when `install` is asked to pin a {@link VersionSpec} tag a manager's
 * own capability declaration (`PackageManagerBackend.versions.accepts`) does
 * not include — `snap` asked for `Exact`, `mas` asked for anything at all.
 * Every backend's own `install` is written as an exhaustive `Match` over the
 * full `VersionSpec` union (see e.g. `backends/macos/Mas.ts`), so an
 * unsupported tag reaches this error at the one call site that noticed,
 * rather than silently reaching the underlying CLI as a bare, unpinned
 * install — the same class of bug rule 0b names for a cast to `unknown`.
 */
export class UnsupportedVersionSpec extends Data.TaggedError("UnsupportedVersionSpec")<{
  manager: string;
  spec: VersionSpec;
  accepts: ReadonlySet<VersionSpec["_tag"]>;
}> {
  override get message() {
    const accepted = Boolean.match(this.accepts.size === 0, {
      onTrue: () => "no VersionSpec at all",
      onFalse: () => [...this.accepts].join(", "),
    });
    return `"${this.manager}" cannot pin by ${this.spec._tag} — it accepts ${accepted}. See PackageVersionSupport in Backend.ts for what this manager can actually honour.`;
  }
}

/**
 * Raised by `Package.ts`'s `apply`, before ever calling a backend's
 * `install`, when {@link PackageVersionSupport.canDowngrade} says this
 * manager cannot move backward and either of two things is true:
 *
 * - `direction: "Ahead"` — `core`'s `compareVersions` positively established
 *   the live version is newer than the pin (both sides parsed as dotted-
 *   numeric). This is the ordinary case: we know it would be a downgrade.
 * - `direction: "Unknown"` — `compareVersions` could not order the two
 *   strings at all (an AUR package's `r1234.deadbeef` VCS version, most real
 *   package-manager version strings once a release/epoch suffix is involved)
 *   *and* the pin is a `VersionSpec.Exact`/`AtLeast` (a fixed target, not a
 *   `Channel`/`Digest`, where "ahead/behind" isn't the right question at
 *   all — see `Package.ts`'s `apply` for exactly which specs this applies
 *   to). Refusing here fails safe: this manager cannot undo a wrong guess,
 *   so an un-orderable mismatch is treated the same as a confirmed one
 *   rather than optimistically attempted.
 *
 * Failing here, loudly and before running anything, is the alternative to
 * letting the underlying CLI fail with whatever confusing text it happens to
 * print for "I don't do that" (or, worse, silently no-op) — see rule 11 in
 * `AGENTS.md`.
 */
export class CannotDowngrade extends Data.TaggedError("CannotDowngrade")<{
  manager: string;
  name: string;
  installed: string;
  desired: string;
  direction: "Ahead" | "Unknown";
}> {
  override get message() {
    const comparison = Boolean.match(this.direction === "Ahead", {
      onTrue: () =>
        `is installed at "${this.installed}", which is newer than the pinned "${this.desired}"`,
      onFalse: () =>
        `is installed at "${this.installed}", which cannot be ordered against the pinned "${this.desired}"`,
    });
    return `"${this.name}" (${this.manager}) ${comparison} — this manager cannot downgrade a package (see PackageVersionSupport.canDowngrade). Uninstall it by hand first if you genuinely want the older version, or drop the pin.`;
  }
}

export type BackendError = CommandError | BackendParseError | PlatformError.PlatformError;

/**
 * Prefixes `sudo` onto `argv` when `execution.privilege` asks for it, argv
 * unchanged otherwise — the one place `sudo` gets spelled into a command, so
 * `privilege: "none"` (already root, or a minimal container with no `sudo`
 * binary at all — see `ExecutionContext`'s own doc comment) never sees it.
 */
export const elevated = (
  execution: ExecutionContext,
  ...argv: readonly string[]
): readonly string[] => (execution.privilege === "sudo" ? ["sudo", ...argv] : argv);

/**
 * One installed package as a manager's own listing reports it — a name, and
 * a version/channel string when that listing can report one at all. Several
 * cannot (`mas`'s `list` has no reason to and none of the others below
 * bother parsing it either, until this type gave `matches` something to
 * compare `version` against): `version` stays absent there rather than a
 * placeholder value, the same "genuinely doesn't have one, not merely
 * skipped" distinction {@link PackageState}'s own `version` field carries
 * through to `Package.ts`'s `matches`.
 */
export interface PackageEntry {
  readonly name: string;
  readonly version?: string;
}

/**
 * The host shell used to answer "is this manager installed?".
 *
 * `command -v` is a POSIX shell builtin and is not a Windows command. Keeping
 * this fact on the backend makes executable discovery part of the backend
 * contract instead of a hidden assumption in the generic reconciler.
 */
export type BackendShell = "posix" | "powershell";

/**
 * The filesystem capability a listing backend may use for a machine-readable
 * export. It is deliberately narrower than `FileSystem`: a backend receives
 * an opaque path and a lazy read operation, never a home directory or a raw
 * filesystem service.
 */
export interface PackageListFile {
  readonly path: string;
  readonly read: Effect.Effect<string, PlatformError.PlatformError>;
}

/**
 * A scoped temporary-artifact capability for package-manager listings.
 *
 * Only backends whose real CLI writes a listing to a file (currently Winget)
 * use it. The generic resource owns allocation and cleanup, so a backend cannot
 * leak a file into the operator's home or repository. The higher-rank callback
 * keeps the context reusable for any error type the backend itself returns.
 */
export interface PackageListContext {
  readonly withTemporaryFile: <A, E>(
    use: (file: PackageListFile) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | PlatformError.PlatformError>;
}

/**
 * Which {@link VersionSpec} tags a manager's `install` can actually honour,
 * and whether, having pinned forward, it can also be pinned backward.
 *
 * This is the "say so in the type" half of version pinning (rule 0b) for
 * `System.Package`: every backend below declares one of these, and every
 * backend's own `install` is written as a `Match.tagsExhaustive` over the
 * *complete* `VersionSpec` union (see e.g. `backends/linux/Snap.ts`), so a
 * tag this struct's `accepts` doesn't include is not silently accepted by a
 * backend that happens not to look at it — it is a compile-time-forced
 * decision inside that backend to fail with {@link UnsupportedVersionSpec}.
 *
 * ## Why this is a field, not a per-manager `Props` tagged union
 *
 * `System.Repo`'s `RepoSpec` (this same file) is a tagged union nested in
 * `RepoProps.repo` precisely because a brew tap, an apt PPA, a dnf COPR
 * project and a Flatpak remote are *different fields entirely* — `tap` vs.
 * `ppa` vs. `project` vs. `name`+`location` — so a manager and a
 * wrong-shaped repo value could type-check as a pair before `RepoSpec`
 * existed. A package manager's version request has no such problem: every
 * manager that can pin at all takes the exact same shape, a `VersionSpec` on
 * a package by that manager's own name. What varies is only *which tags of
 * that one shared shape* a given manager's `install` can act on — a
 * constraint on one field's legal values, not a difference in which fields
 * exist. `RuntimeToolProps` (`runtimes/src/Tool.ts`) is the closer precedent
 * for that situation, and it *is* a tagged union — but there, `Rustup`'s
 * `channel` field is not merely a narrower `version`, it is a conceptually
 * different question (a moving target vs. a fixed one), which earns it a
 * different field name, not just a different accepted value. `System.Package`
 * has no such distinct concept per manager to carry.
 *
 * A full `PackageProps` tagged union keyed by manager (19 cases, one per
 * `PackageManagerId`) was considered and rejected for this reason: it would
 * buy compile-time-checked narrowing of `version`'s type at the one dispatch
 * site in `Package.ts`, at the cost of renaming every existing recipe/test
 * call site's `{ manager: "brew", name }` to a `_tag`-keyed case (mirroring
 * `RuntimeToolProps`'s `Mise`/`Asdf`/`Rustup`/`Uv` — see that module's own
 * doc comment for why `Props`, unlike `Attributes`, is even allowed to be a
 * union under Alchemy's `Resource<>`), for a distinction (which values are
 * legal, not which fields exist) that this struct plus an exhaustive
 * `Match` inside each backend already makes impossible to silently get
 * wrong. If a future manager's version request turns out to need its own
 * distinct *field* (not just a narrower set of legal `VersionSpec` tags),
 * that is the signal to revisit this decision — the same signal
 * `RuntimeToolProps.Rustup.channel` was for `Runtime.Tool`.
 */
/**
 * How long this manager's own operations are allowed to take.
 *
 * Declared per backend, alongside {@link PackageVersionSupport}, because the tool
 * is the only thing that knows: `brew install` may compile from source, `apt-get
 * install` is a download and unpack, `mas` waits on the App Store. A central
 * table of durations would still be someone else guessing on the tool's behalf,
 * and a bare literal at the `exec` site says nothing about why that number.
 *
 * `core`'s `Timeouts` supplies the vocabulary so the *classes* of duration stay
 * consistent and adjustable in one place; which class applies is this backend's
 * call.
 */
export interface PackageTimeouts {
  /** Installing or upgrading one package. */
  readonly install: Duration.Input;
  /** Refreshing the local index, where this manager has one. */
  readonly refresh: Duration.Input;
}

export interface PackageVersionSupport {
  readonly accepts: ReadonlySet<VersionSpec["_tag"]>;
  readonly canDowngrade: boolean;
}

/** A manager that cannot pin a version at all — `mas`, whose `install` takes only an App Store id. */
export const NO_VERSION_SUPPORT: PackageVersionSupport = {
  accepts: new Set(),
  canDowngrade: false,
};

/**
 * The one-line failure every backend's `install` reaches for a
 * {@link VersionSpec} tag its own {@link PackageVersionSupport.accepts}
 * doesn't include — a shared helper so raising {@link UnsupportedVersionSpec}
 * is exactly as easy as ignoring the tag would have been, which is the whole
 * point: nothing here should be tempted to fall through to an unpinned
 * install just because writing the rejection by hand felt like more code.
 */
export const rejectUnsupportedVersionSpec =
  (manager: string, versions: PackageVersionSupport) =>
  (spec: VersionSpec): Effect.Effect<never, UnsupportedVersionSpec> =>
    Effect.fail(new UnsupportedVersionSpec({ manager, spec, accepts: versions.accepts }));

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
  /** Binary or command name this backend invokes for both probing and work. */
  readonly executable: string;
  /** Shell in which the executable can be probed. */
  readonly shell: BackendShell;
  /** See {@link PackageVersionSupport}. */
  readonly versions: PackageVersionSupport;
  readonly timeouts: PackageTimeouts;
  readonly list: (
    exec: Exec,
    /** Required by file-exporting backends; absent only for direct legacy calls. */
    context?: PackageListContext,
  ) => Effect.Effect<PackageEntry[], BackendError>;
  /**
   * `version` is always the full `VersionSpec | undefined` a recipe wrote —
   * never pre-filtered by `versions.accepts` — so every implementation is
   * forced (via `Match.tagsExhaustive`) to decide what happens for every tag,
   * not just the ones it planned for. `undefined` means "no pin requested":
   * install whatever the manager resolves as current, the same as before
   * this type existed.
   */
  readonly install: (
    name: string,
    version: VersionSpec | undefined,
    exec: Exec,
    /** How to run a command that needs root — see {@link elevated}. */
    execution: ExecutionContext,
  ) => Effect.Effect<void, BackendError | UnsupportedVersionSpec>;
  /**
   * Refreshes this manager's local package index/metadata cache before an
   * install that needs it — real, not hypothetical: `apt-get install` and
   * `pacman -S` both fail outright ("Unable to locate package"/"target not
   * found") against a stale or absent local index, and neither refreshes it
   * on its own. Absent for managers that talk to a live registry per-command
   * and keep no local index to go stale (`cargo`, `npm`, `pipx`, `uv tool`,
   * `gem`, `go install`), or where refreshing is a real, separate,
   * unaddressed gap — see each backend's own doc comment.
   */
  readonly refreshIndex?: (
    exec: Exec,
    execution: ExecutionContext,
  ) => Effect.Effect<void, BackendError>;
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
  readonly addRepo: (
    repo: Spec,
    exec: Exec,
    execution: ExecutionContext,
  ) => Effect.Effect<void, BackendError>;
}
