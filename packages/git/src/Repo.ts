import { MachinePaths, Sh } from "@machine-run/core";
import { type Exec, type Reconciler, toProvider } from "@machine-run/engine";
import type { CommandError } from "alchemy/Command";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { isExitCode, stderrOf } from "./exitCode.ts";

/**
 * Ensures a clone of `remote` exists at `path` — dotfiles repos, work
 * checkouts, anything cloned once and then left to its owner.
 *
 * A `Reconciler`, not a `Git.Config` composition: unlike every other resource
 * in this package, what's being converged is a working tree and a `.git`
 * directory, not a config key, and the hazard this resource exists to manage
 * — never destroying uncommitted work — has nothing to do with `git config`.
 *
 * ## What `apply` will do, and what it never will
 *
 * Only two operations exist: `git clone` when nothing is at `path` yet, and
 * `git remote add|set-url origin` when the repository is there but points
 * somewhere else. Verified against real git 2.50.1 that the second is safe
 * regardless of working-tree state — `remote set-url` edits only
 * `.git/config` — by running it against a repository with both a modified
 * tracked file and an untracked file and finding both byte-for-byte
 * unchanged afterward.
 *
 * There is deliberately no third operation. `apply` never runs `checkout`,
 * `reset`, `clean`, `pull`, or `fetch` — the operations an "ensure this repo
 * is up to date" tool reaches for, and exactly the ones that can discard
 * uncommitted or unpushed work. `Reconciler.unapply` is unset for the same
 * reason `System.Package` leaves it unset: there is nothing safe to undo
 * (see `@machine-run/engine`'s `Reconciler.ts`).
 *
 * ## `observe`'s three (really four) outcomes
 *
 * - **Not there**: `path` does not exist, or exists as an empty directory
 *   (verified: `git clone` into an already-existing *empty* directory
 *   succeeds exactly like cloning into a path that doesn't exist yet, and
 *   also creates any missing parent directories itself — no
 *   `fs.makeDirectory` needed here). `observe` returns `undefined`.
 * - **There, correct remote**: `path` is itself a repository root (see the
 *   toplevel check below) whose `origin` points at `props.remote`.
 * - **There, different remote** (including "no `origin` at all" — modelled
 *   as an absent `remote` field rather than a fourth case, since both mean
 *   "the desired value isn't there yet" to `matches`): the fix is `remote
 *   add` or `remote set-url`, chosen by whether one already exists.
 * - **Occupied by something else**: `path` exists, is non-empty, and is not
 *   its own repository root. Raised as {@link GitRepoPathOccupied} rather
 *   than silently treated as absent — cloning would either fail loudly
 *   anyway (verified: `git clone` into a non-empty non-repo directory exits
 *   `128` with "already exists and is not an empty directory") or, worse,
 *   silently adopt unrelated content. This mirrors `Symlink`'s refusal to
 *   auto-adopt.
 *
 * The nested-repository trap this guards against is real, not theoretical:
 * verified that `git -C <path> rev-parse --is-inside-work-tree` answers
 * `true` for an empty subdirectory *inside* an unrelated ancestor
 * repository — it says nothing about whether `path` itself was ever
 * `git init`'d. `--show-toplevel`'s output must be compared against `path`
 * itself, not merely checked for success. Both sides are resolved with
 * `FileSystem.realPath` before comparing (not just `MachinePaths.expand`):
 * on macOS specifically, `/tmp` is itself a symlink to `/private/tmp`, so a
 * literal-string comparison of two otherwise-identical absolute paths can
 * disagree over exactly the boundary a symlinked tmpdir crosses.
 *
 * ## What is *not* verified
 *
 * `git remote get-url origin` returns only the first configured fetch URL.
 * A repository hand-configured with additional push URLs via `remote
 * set-url --add` is not fully represented here — only that first URL
 * participates in drift detection, matching the scope of `props.remote`
 * (one URL, not a list).
 */
export const GitRepoProps = Schema.Struct({
  /** Where the clone should exist. `~` is expanded. */
  path: Schema.String,
  /** The URL (or local path) the `origin` remote should point at. */
  remote: Schema.String,
  /**
   * Branch to check out when cloning fresh. Has no effect once a clone
   * exists — `apply` never runs `checkout`, so an existing repository's
   * current branch is left exactly as its owner left it, deliberately.
   */
  branch: Schema.optionalKey(Schema.String),
});

export type GitRepoProps = typeof GitRepoProps.Type;

/**
 * `remote` is absent when the repository exists but has no `origin` at all —
 * distinct from "wrong remote" only in that `matches` treats both the same
 * way: neither equals `desired.remote`, so both need an `apply`.
 */
export const GitRepoState = Schema.Struct({
  path: Schema.String,
  remote: Schema.optionalKey(Schema.String),
});

export type GitRepoState = typeof GitRepoState.Type;

export interface Repo extends Resource<"Git.Repo", GitRepoProps, GitRepoState> {}

export const Repo = Resource<Repo>("Git.Repo");

/**
 * `path` exists and is not the repository this resource manages — a file, an
 * unrelated non-empty directory, or a directory inside a *different*
 * repository. `apply` never deletes or overwrites it to make room for a
 * clone; the operator has to move it or confirm it's safe to lose by hand.
 */
export class GitRepoPathOccupied extends Data.TaggedError("GitRepoPathOccupied")<{
  path: string;
  detail: string;
}> {
  override get message() {
    return `"${this.path}" exists and is not the git repository this resource manages: ${this.detail}. Git.Repo never deletes or overwrites existing content to make room for a clone — move or remove it by hand, then re-run.`;
  }
}

/** `git` failed for a reason other than the ordinary "no such remote" (on read). */
export class GitRepoCommandFailed extends Data.TaggedError("GitRepoCommandFailed")<{
  path: string;
  cause: CommandError;
}> {
  override get message() {
    return `git failed while reconciling the repository at "${this.path}": ${this.cause.message}`;
  }
}

export type GitRepoError = GitRepoPathOccupied | GitRepoCommandFailed;

/**
 * The repository root `path` is inside, or `None` if `path` is not inside any
 * git repository at all.
 *
 * Verified: a fatal `rev-parse --show-toplevel` always exits `128`, but so do
 * unrelated fatal errors (a corrupt `.git`, an unreadable parent directory) —
 * exit code alone would misclassify those as "not a repository". The stderr
 * check is best-effort text matching for exactly that reason: it only
 * narrows the *common* case, and anything that doesn't match it is treated
 * as a real failure rather than silently swallowed.
 */
const showToplevel = (
  target: string,
  exec: Exec,
): Effect.Effect<Option.Option<string>, GitRepoCommandFailed> =>
  exec({
    command: Sh.sh("git", "-C", target, "rev-parse", "--show-toplevel"),
    shell: true,
  }).pipe(
    Effect.map((result) => Option.some(result.stdout.trim())),
    Effect.catch((error) =>
      isExitCode(error, 128) && /not a git repository/i.test(stderrOf(error))
        ? Effect.succeed(Option.none())
        : Effect.fail(new GitRepoCommandFailed({ path: target, cause: error })),
    ),
  );

/**
 * The first configured fetch URL of `origin`, or `undefined` when no such
 * remote is configured.
 *
 * Verified: `git remote get-url origin` exits `2` with "No such remote
 * 'origin'" when unset, distinct from every other failure this can raise.
 */
const getOriginUrl = (
  target: string,
  exec: Exec,
): Effect.Effect<string | undefined, GitRepoCommandFailed> =>
  exec({
    command: Sh.sh("git", "-C", target, "remote", "get-url", "origin"),
    shell: true,
  }).pipe(
    Effect.map((result) => result.stdout.trim()),
    Effect.catch((error) =>
      isExitCode(error, 2)
        ? Effect.succeed(undefined)
        : Effect.fail(new GitRepoCommandFailed({ path: target, cause: error })),
    ),
  );

export const makeGitRepoReconciler: Effect.Effect<
  Reconciler<GitRepoProps, GitRepoState, GitRepoError>,
  never,
  FileSystem.FileSystem | MachinePaths
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* MachinePaths;

  return {
    address: (props) => paths.expand(props.path),

    observe: (props, ctx) =>
      Effect.gen(function* () {
        const target = paths.expand(props.path);

        const info = yield* fs.stat(target).pipe(Effect.orElseSucceed(() => undefined));
        if (info === undefined) return undefined;

        if (info.type !== "Directory") {
          return yield* Effect.fail(
            new GitRepoPathOccupied({ path: target, detail: "a file occupies this path" }),
          );
        }

        const entries = yield* fs
          .readDirectory(target)
          .pipe(Effect.orElseSucceed((): readonly string[] => []));

        const toplevel = yield* showToplevel(target, ctx.exec);

        if (Option.isSome(toplevel)) {
          // Resolved with `realPath`, not just `MachinePaths.expand`: on
          // macOS `/tmp` is itself a symlink to `/private/tmp`, so a
          // literal-string comparison of two otherwise-identical absolute
          // paths can disagree over exactly that boundary.
          const realRoot = yield* fs
            .realPath(toplevel.value)
            .pipe(Effect.orElseSucceed(() => toplevel.value));
          const realTarget = yield* fs.realPath(target).pipe(Effect.orElseSucceed(() => target));

          if (realRoot === realTarget) {
            const remote = yield* getOriginUrl(target, ctx.exec);
            return { path: target, ...(remote !== undefined ? { remote } : {}) };
          }
        }

        // Either not inside any repository, or inside one rooted somewhere
        // else entirely (the nested-directory trap — see this module's doc
        // comment). An empty directory is exactly what a fresh `git clone`
        // accepts; anything else here is content this resource did not put
        // there and will not clear away.
        if (entries.length === 0) return undefined;

        return yield* Effect.fail(
          new GitRepoPathOccupied({
            path: target,
            detail: Option.isSome(toplevel)
              ? `it is inside a different repository rooted at "${toplevel.value}"`
              : "it holds unrelated content, not a git repository",
          }),
        );
      }),

    desired: (props) => Effect.succeed({ path: paths.expand(props.path), remote: props.remote }),

    matches: (observed, desired) =>
      observed.path === desired.path && observed.remote === desired.remote,

    apply: ({ props, observed, desired }, ctx) =>
      Effect.gen(function* () {
        if (observed === undefined) {
          yield* ctx
            .exec({
              command: Sh.sh(
                "git",
                "clone",
                ...(props.branch !== undefined ? ["--branch", props.branch] : []),
                "--origin",
                "origin",
                props.remote,
                desired.path,
              ),
              shell: true,
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.fail(new GitRepoCommandFailed({ path: desired.path, cause })),
              ),
            );
          return desired;
        }

        if (observed.remote !== props.remote) {
          const args =
            observed.remote === undefined
              ? ["remote", "add", "origin", props.remote]
              : ["remote", "set-url", "origin", props.remote];
          yield* ctx
            .exec({ command: Sh.sh("git", "-C", desired.path, ...args), shell: true })
            .pipe(
              Effect.catch((cause) =>
                Effect.fail(new GitRepoCommandFailed({ path: desired.path, cause })),
              ),
            );
        }
        return desired;
      }),
  };
});

export const RepoProvider = () => toProvider(Repo, makeGitRepoReconciler);
