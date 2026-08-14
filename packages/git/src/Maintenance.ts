import { MachinePaths, Sh } from "@machine-run/core";
import { type Drift, type Exec, type Reconciler, toProvider } from "@machine-run/engine";
import type { CommandError } from "alchemy/Command";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { resolveGlobalConfigPath, splitNulTerminated } from "./Config.ts";
import { isExitCode, stderrOf } from "./exitCode.ts";
import { showToplevel } from "./toplevel.ts";

/**
 * Ensures `git maintenance` background upkeep (incremental `gc`,
 * `commit-graph`, repacking) is running for one repository —
 * `git maintenance start`, the one item named in V1-PLAN's git table that
 * was never built.
 *
 * ## `start`/`stop` are not a matched pair — verified, not assumed
 *
 * `git maintenance start` does two things at once, container-verified
 * (`docker run --rm ubuntu:24.04`, git 2.43.0, 2026-08-14): it performs the
 * equivalent of `register` (adds this repository's canonical toplevel path
 * to the **global**, multi-valued `maintenance.repo`, and sets
 * `maintenance.auto`/`maintenance.strategy` in *this repository's own* local
 * config), then installs a background schedule — a crontab block on Linux
 * (confirmed; a systemd timer is documented but wasn't reachable to verify
 * the same way, and this was never run against real macOS `launchd` either,
 * so that scheduler path is UNVERIFIED) shared by **every** repository
 * registered on the machine, not just this one.
 *
 * `git maintenance stop`, verified in the same container, only tears down
 * that shared schedule — the crontab block disappears entirely — but leaves
 * `maintenance.repo` completely untouched. It is a **machine-wide** action:
 * calling it from one `Git.Maintenance` resource's `unapply` would silence
 * background maintenance for every other repository the same machine has
 * registered, including ones this recipe knows nothing about. That is why
 * `unapply`, below, calls `unregister` instead — see its own doc comment.
 *
 * ## Why `observe` checks `maintenance.repo`, not `maintenance.strategy`
 *
 * The obvious-looking `git config --get maintenance.strategy` is a tempting
 * live-state check, but it is sticky and unreliable: container-verified that
 * `unregister` (and therefore, transitively, `stop`, since `stop` never calls
 * `unregister`) never clears `maintenance.auto`/`maintenance.strategy` from
 * the repository's local config. A repository that was registered and later
 * unregistered still answers `--get maintenance.strategy` with `incremental`
 * forever — that key does not reflect current registration at all, only
 * "was this repo ever registered, at some point, once". `maintenance.repo`
 * (global, multi-valued) is the one signal that genuinely toggles in both
 * directions — `register` adds this repository's path, `unregister` removes
 * it, both verified — so `observe` below checks membership in that list.
 *
 * ## Address: shared with `Git.Config`, not the repo path
 *
 * `register`/`start` both write to the exact same global config file
 * `Git.Config` writes to (the `maintenance.repo` key lives alongside
 * `user.name`, `credential.helper`, and everything else `Git.Config`
 * manages) — so this resource's {@link Reconciler.address} resolves to that
 * same file (`resolveGlobalConfigPath`, exported from `Config.ts`) rather
 * than to `props.repo`. Sharing the address means sharing the `FileLock`: a
 * `Git.Maintenance` apply cannot race a concurrent `Git.Config` write to the
 * same file, at the cost of serialising against every other
 * `Git.Config`/`Git.Maintenance` resource regardless of which key or repo it
 * touches — the same trade `Git.Config` itself already makes for every key
 * it manages, and for the same reason: `docs/notes/git-notes.md` records
 * that 20 of 30 concurrent `git config --global` writers failed on git's own
 * file lock.
 */
export const GitMaintenanceProps = Schema.Struct({
  /** Path to the repository background maintenance should run against. `~` is expanded. */
  repo: Schema.String,
});

export type GitMaintenanceProps = typeof GitMaintenanceProps.Type;

export const GitMaintenanceState = Schema.Struct({
  repo: Schema.String,
});

export type GitMaintenanceState = typeof GitMaintenanceState.Type;

export interface Maintenance extends Resource<
  "Git.Maintenance",
  GitMaintenanceProps,
  GitMaintenanceState
> {}

export const Maintenance = Resource<Maintenance>("Git.Maintenance");

/**
 * `props.repo` does not resolve to a git repository at all (`rev-parse
 * --show-toplevel` reports "not a git repository"). Unlike `Git.Repo`, this
 * resource never creates a repository — it assumes one already exists — so
 * an absent one is a configuration mistake worth failing on loudly, not an
 * ordinary state to converge from.
 */
export class GitMaintenanceRepoNotFound extends Data.TaggedError("GitMaintenanceRepoNotFound")<{
  repo: string;
}> {
  override get message() {
    return `"${this.repo}" is not a git repository. Git.Maintenance never creates one — point it at a path Git.Repo (or a manual clone) already manages.`;
  }
}

/**
 * `git maintenance start` failed because neither a systemd user instance nor
 * `crontab` is available to schedule the background job. Container-verified
 * exact failure: `fatal: neither systemd timers nor crontab are available`,
 * exit `128`. Called out as its own typed error rather than folded into
 * {@link GitMaintenanceCommandFailed} because it's a genuinely common,
 * actionable case — a minimal container, a locked-down server with no cron —
 * not an arbitrary git failure.
 */
export class GitMaintenanceSchedulerUnavailable extends Data.TaggedError(
  "GitMaintenanceSchedulerUnavailable",
)<{
  repo: string;
}> {
  override get message() {
    return `git maintenance start for "${this.repo}" found neither systemd timers nor crontab available to schedule the background job. Install cron (or, on Linux, a working "systemd --user" instance) first.`;
  }
}

/** `git` failed for a reason other than the two named above. */
export class GitMaintenanceCommandFailed extends Data.TaggedError("GitMaintenanceCommandFailed")<{
  repo: string;
  cause: CommandError;
}> {
  override get message() {
    return `git failed while reconciling maintenance for "${this.repo}": ${this.cause.message}`;
  }
}

export type GitMaintenanceError =
  | GitMaintenanceRepoNotFound
  | GitMaintenanceSchedulerUnavailable
  | GitMaintenanceCommandFailed;

/**
 * The canonical toplevel path git itself resolves `target` to — exactly the
 * spelling `maintenance.repo` stores on registration (verified: registering
 * the same repository twice never duplicates the entry, so git is comparing
 * against this same canonical form, not whatever string was passed to `-C`).
 */
/**
 * The repository's canonical top level, or `GitMaintenanceRepoNotFound`.
 *
 * The "not a repository" case arrives as a *failure*, not as an empty result —
 * measured, because the code path suggests otherwise. Both a missing directory
 * and an existing non-repository exit `128`, with distinct stderr:
 *
 *     git -C /missing     rev-parse --show-toplevel
 *       -> fatal: cannot change to '/missing': No such file or directory
 *     git -C /real-non-repo rev-parse --show-toplevel
 *       -> fatal: not a git repository (or any of the parent directories): .git
 *
 * So this classifies on stderr. Getting it wrong meant `observe` reported a
 * generic command failure for a repository another resource had simply not
 * cloned yet, which made the whole plan unrenderable.
 */
const resolveRepo = (target: string, exec: Exec): Effect.Effect<string, GitMaintenanceError> =>
  showToplevel(target, exec).pipe(
    Effect.mapError((cause: CommandError) =>
      /cannot change to|not a git repository/i.test(stderrOf(cause))
        ? new GitMaintenanceRepoNotFound({ repo: target })
        : new GitMaintenanceCommandFailed({ repo: target, cause }),
    ),
    Effect.flatMap((toplevel) =>
      Option.isSome(toplevel)
        ? Effect.succeed(toplevel.value)
        : Effect.fail(new GitMaintenanceRepoNotFound({ repo: target })),
    ),
  );

/**
 * Whether `repoToplevel` is currently listed in the global, multi-valued
 * `maintenance.repo` — verified: `--get-all` on a wholly unset key exits `1`
 * with empty output, mirroring `Config.ts`'s `getAll`.
 */
const isRegistered = (
  repoToplevel: string,
  exec: Exec,
): Effect.Effect<boolean, GitMaintenanceCommandFailed> =>
  exec({
    command: Sh.sh("git", "config", "--global", "--get-all", "-z", "maintenance.repo"),
    shell: true,
  }).pipe(
    Effect.map((result) => splitNulTerminated(result.stdout).includes(repoToplevel)),
    Effect.catch((error) =>
      isExitCode(error, 1)
        ? Effect.succeed(false)
        : Effect.fail(new GitMaintenanceCommandFailed({ repo: repoToplevel, cause: error })),
    ),
  );

/**
 * Starts background maintenance for `repo` (`git -C <repo> maintenance
 * start`) — registers it in `maintenance.repo` and installs the shared
 * schedule; see this module's doc comment for exactly what that means and
 * doesn't mean. Classifies the one common, actionable failure
 * (no scheduler available) into its own typed error rather than folding it
 * into the generic one.
 */
const startMaintenance = (
  repo: string,
  exec: Exec,
): Effect.Effect<
  void,
  GitMaintenanceSchedulerUnavailable | GitMaintenanceCommandFailed | GitMaintenanceRepoNotFound
> =>
  exec({
    command: Sh.sh("git", "-C", repo, "maintenance", "start"),
    shell: true,
  }).pipe(
    Effect.asVoid,
    Effect.catch((error: CommandError) => {
      // `observe` reports an absent repository as `Option.none()` so a plan can
      // be rendered before whatever clones it has run, which leaves `apply` as
      // the place that has to name the problem. Classified from git's own stderr
      // rather than by running an extra `rev-parse` first: one subprocess per
      // apply to improve a message the failure already contains is not a trade
      // worth making, and the `SchedulerUnavailable` case beside this one
      // already establishes the pattern.
      const stderr = stderrOf(error);
      const classified:
        | GitMaintenanceSchedulerUnavailable
        | GitMaintenanceCommandFailed
        | GitMaintenanceRepoNotFound = isExitCode(error, 128)
        ? /neither systemd timers nor crontab/i.test(stderr)
          ? new GitMaintenanceSchedulerUnavailable({ repo })
          : /cannot change to|not a git repository/i.test(stderr)
            ? new GitMaintenanceRepoNotFound({ repo })
            : new GitMaintenanceCommandFailed({ repo, cause: error })
        : new GitMaintenanceCommandFailed({ repo, cause: error });
      return Effect.fail(classified);
    }),
  );

/**
 * Removes `repo`'s own registration (`git -C <repo> maintenance unregister
 * --force`) — deliberately not `stop`; see this module's doc comment for why.
 */
const unregisterMaintenance = (
  repo: string,
  exec: Exec,
): Effect.Effect<void, GitMaintenanceCommandFailed> =>
  exec({
    command: Sh.sh("git", "-C", repo, "maintenance", "unregister", "--force"),
    shell: true,
  }).pipe(
    Effect.asVoid,
    Effect.catch((error) => Effect.fail(new GitMaintenanceCommandFailed({ repo, cause: error }))),
  );

export const makeGitMaintenanceReconciler: Effect.Effect<
  Reconciler<GitMaintenanceProps, GitMaintenanceState, GitMaintenanceError>,
  never,
  FileSystem.FileSystem | Path.Path | MachinePaths
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* MachinePaths;
  const globalConfigPath = yield* resolveGlobalConfigPath(fs, path, paths);

  return {
    // See this module's doc comment: shared with every `Git.Config`
    // resource's own address, not `props.repo`.
    address: () => globalConfigPath,

    observe: (props, ctx) =>
      Effect.gen(function* () {
        const target = paths.expand(props.repo);
        const toplevel = yield* resolveRepo(target, ctx.exec).pipe(
          Effect.map(Option.some),
          // A repository that does not exist yet is not a failure to observe: no
          // registration for it can be active, which is exactly what
          // `Option.none()` means. Failing here instead made this resource
          // unplannable whenever the repo is created by another resource in the
          // same deploy — `plan` could not even be *rendered*, which is the one
          // thing a plan has to do before anything is applied. `apply` still
          // fails on a missing repo, where it genuinely cannot proceed.
          Effect.catchTag("GitMaintenanceRepoNotFound", () =>
            Effect.succeed(Option.none<string>()),
          ),
        );
        if (Option.isNone(toplevel)) return Option.none();
        const registered = yield* isRegistered(toplevel.value, ctx.exec);
        if (!registered) return Option.none();
        return Option.some({ repo: target });
      }),

    desired: (props) => Effect.succeed({ repo: paths.expand(props.repo) }),

    matches: (observed, desired) => observed.repo === desired.repo,

    // `repo` is a path, not ordered — no `direction`. In practice `observe`
    // only ever reports a repo under this same address once it's registered
    // under exactly `desired.repo`, so this is empty whenever `matches` is —
    // recorded honestly rather than hand-waved.
    drift: (observed, desired): Drift =>
      observed.repo === desired.repo
        ? []
        : [{ field: "repo", observed: observed.repo, desired: desired.repo }],

    apply: ({ desired }, ctx) =>
      Effect.gen(function* () {
        yield* startMaintenance(desired.repo, ctx.exec);
        return desired;
      }),

    /**
     * Deliberately `unregister --force`, not `stop` — see this module's doc
     * comment. `stop` tears down the shared background schedule for every
     * registered repository on the machine; `unregister` removes only this
     * repository's own participation, the correctly-scoped undo of what
     * `apply` did for *this* resource. `--force` makes it idempotent:
     * verified that unregistering an already-unregistered repository exits
     * `128` ("fatal: repository '<path>' is not registered") without it,
     * and `0` with no output with it — cheap insurance against a race with
     * something else unregistering the same repository in between, since
     * `unapply` otherwise only runs when `observe` just found it registered.
     */
    unapply: ({ recorded }, ctx) => unregisterMaintenance(recorded.repo, ctx.exec),
  };
});

export const MaintenanceProvider = () => toProvider(Maintenance, makeGitMaintenanceReconciler);
