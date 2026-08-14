import * as Core from "@machine-run/core";
import type { CommandRunProps } from "alchemy/Command";
import type { CommandError } from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type * as Duration from "effect/Duration";

/**
 * The output of a command, as `CommandExecutor` returns it.
 */
export interface CommandOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * {@link CommandRunProps} with `command` narrowed to `ShellCommand`.
 *
 * Alchemy's own type has `command: string`, which cannot tell a value built by
 * `Sh.sh`/`Sh.pwsh` (or deliberately escaped via `Sh.unsafeRaw`) apart from a
 * raw template literal. Narrowing it here is what makes the brand load-bearing
 * at the one place every reconciler actually runs a command.
 */
export type ExecProps = Omit<CommandRunProps, "command"> & {
  readonly command: Core.Sh.ShellCommand;
};

/**
 * Runs a command and returns its output.
 *
 * Which status session the command reports to is bound by the engine, per
 * phase, so nothing downstream has to know a session exists.
 */
export type Exec = (props: ExecProps) => Effect.Effect<CommandOutput, CommandError>;

/**
 * What a reconciler is allowed to do while *looking* at the machine.
 *
 * Observation must be free of consequence: it runs during planning, when the
 * operator has been promised that nothing changes. The only capability offered
 * is running a command, and reconcilers are expected to run read-only ones.
 *
 * Commands here carry no status session, because planning has no apply session
 * to attach progress to. Binding that decision into the context means no
 * reconciler has to know a session exists at all.
 */
export interface ObserveContext {
  readonly exec: Exec;
  /**
   * How this run behaves — privilege, locale, default timeout.
   *
   * Optional so it could be introduced without rewriting every construction
   * site at once. Read it through {@link executionOf}, which supplies
   * {@link DEFAULT_EXECUTION} when it is absent, rather than testing for
   * `undefined` at each use.
   */
  readonly execution?: ExecutionContext;
}

/**
 * The properties of the *run* rather than of any resource: things every backend
 * needs and none should hardcode.
 *
 * Each field replaces a literal that was previously repeated per backend —
 * `sudo` spelled into ten command strings, a locale nothing pinned at all, and
 * timeouts as 57 inline duration strings.
 */
export interface ExecutionContext {
  /**
   * Whether commands that need root should be elevated, and how.
   *
   * `"none"` covers both "already root" and "no escalation available" — a
   * container with no `sudo` installed is the common case, and prefixing `sudo`
   * there fails with `command not found` rather than a permission error.
   */
  readonly privilege: "none" | "sudo";
  /**
   * Locale for subprocesses whose output is parsed. `"C"` by default: every
   * backend that greps CLI output is otherwise at the mercy of the operator's
   * language, and CI runs in English so nothing catches it.
   */
  readonly locale: string;
  /** Applied to a command that does not ask for its own timeout. */
  readonly defaultTimeout: Duration.Input;
}

/**
 * What a run does when nothing says otherwise: no escalation, a locale that
 * makes CLI output parseable, and a ceiling generous enough for a package
 * install.
 */
export const DEFAULT_EXECUTION: ExecutionContext = {
  privilege: "none",
  locale: "C",
  defaultTimeout: "10 minutes",
};

/** The run's execution context, defaulted. */
export const executionOf = (ctx: ObserveContext): ExecutionContext =>
  ctx.execution === undefined ? DEFAULT_EXECUTION : ctx.execution;

/**
 * Decides `privilege` by asking the machine rather than assuming.
 *
 * Three real cases, and no default covers more than one of them: already root
 * (escalation is unnecessary, and `sudo` may not even be installed), not root
 * with `sudo` available (escalation is required for a package install), and not
 * root without it (nothing can escalate, so the honest answer is to run
 * unprivileged and let the command fail with the real permission error rather
 * than `sudo: command not found`).
 *
 * Both probes are shell built-ins or coreutils and neither mutates anything, so
 * this is safe to run before a plan. Failure of either probe is read as its
 * negative — a machine that cannot answer `id -u` is not one to assume root on.
 */
export const detectPrivilege = (
  exec: Exec,
): Effect.Effect<ExecutionContext["privilege"], never> =>
  Effect.gen(function* () {
    // `Effect.exit` rather than `orElseSucceed`, because an executor that cannot
    // answer may *die* rather than fail — a stubbed one in a test does exactly
    // that — and a defect would otherwise escape a probe that is meant to be
    // unable to break a run.
    const stdoutOf = (command: Core.Sh.ShellCommand) =>
      Effect.exit(exec({ command, shell: true })).pipe(
        Effect.map((result) =>
          Exit.isSuccess(result) ? Option.some(result.value.stdout.trim()) : Option.none<string>(),
        ),
      );

    const uid = yield* stdoutOf(Core.Sh.sh("id", "-u"));
    if (Option.exists(uid, (value) => value === "0")) return "none";

    const sudo = yield* stdoutOf(Core.Sh.sh("command", "-v", "sudo"));
    return Option.exists(sudo, (value) => value !== "") ? "sudo" : "none";
  });

/**
 * What a reconciler is allowed to do while *changing* the machine.
 *
 * Commands run here are attached to the live apply session, so their output
 * streams to the operator as progress.
 */
export interface ApplyContext extends ObserveContext {
  /**
   * Preserve whatever currently occupies a path before overwriting it.
   * Resolves to the backup's destination, or `undefined` when there was
   * nothing at `path` to preserve.
   *
   * Normally called by the engine, not by reconcilers — see
   * {@link Reconciler.address} and {@link Reconciler.snapshotBeforeApply}.
   * A reconciler whose {@link Reconciler.unapply} can restore a prior value
   * is the one exception: it may call this itself during {@link
   * Reconciler.apply} and fold the returned path into its own `State`, which
   * is the only way a later `unapply` can find it again — `Backups`' own
   * directory is stamped fresh per run, so nothing but the resource's
   * persisted state can carry a path from one run to a much later one.
   */
  readonly snapshot: (path: string) => Effect.Effect<string | undefined>;
}

/**
 * The situation a reconciler is asked to converge from.
 */
export interface ApplyInput<Props, State> {
  readonly props: Props;
  /**
   * Live state as observed immediately beforehand, or `Option.none()` when
   * there is nothing at this address yet. Reconcilers converge from what is
   * actually there rather than from what was recorded, so an apply that
   * resumes after a partial failure sees the truth.
   */
  readonly observed: Option.Option<State>;
  /** What {@link Reconciler.desired} computed for these props. */
  readonly desired: State;
  /**
   * Where the engine archived what was at this address before this apply, when
   * {@link Reconciler.snapshotBeforeApply} is set and the contents were not this
   * resource's own previous output.
   *
   * Handed over so a reconciler whose {@link Reconciler.unapply} restores rather
   * than removes can fold the path into its own `State` — the backup directory
   * is stamped fresh per run, so nothing but persisted state carries a path to a
   * much later `destroy`. Taking it from here rather than calling
   * `ctx.snapshot` again is what keeps one apply to one snapshot, and keeps the
   * "only archive what a person may have written" condition in one place.
   */
  readonly snapshot?: string;
}

/**
 * A reconciler describes how to bring one addressable piece of a machine to a
 * desired state. It is deliberately narrower than an Alchemy provider.
 *
 * An Alchemy provider is a set of engine callbacks receiving plan bookkeeping —
 * logical ids, fully-qualified names, instance ids, binding tables, status
 * sessions. Machine state needs none of that; what it needs is a way to look at
 * the machine, a way to say what should be true, and a way to converge. Naming
 * only those three collapses the surface that each resource has to get right,
 * and moves the decisions that were being made separately (and inconsistently)
 * in every resource into one place:
 *
 * - Drift is detected by comparing observation against desire, so a reconciler
 *   cannot accidentally compare against its own last-recorded output and become
 *   blind to changes made by anything else.
 * - Every prop participates in that comparison, because the comparison is over
 *   whole states rather than hand-picked fields.
 * - Mutual exclusion and pre-overwrite snapshotting are derived from
 *   {@link address}, so they cannot be forgotten per resource.
 * - Planning and applying get different capabilities by construction.
 */
/**
 * One field of an observed state that does not satisfy the desired one.
 *
 * `matches` answers *whether* a resource drifted; this answers *what* and, when
 * the values are ordered, *which way*. A plan that can only print `update` is
 * the difference between a diff and a list of names.
 */
export interface DriftField {
  /** The state field that differs, as a reader would name it: `mode`, `version`. */
  readonly field: string;
  readonly observed: string;
  readonly desired: string;
  /**
   * Set only when the two values are genuinely ordered — a version, a mode.
   * Absent for unordered values, where "behind" would be an invented claim.
   */
  readonly direction?: "behind" | "ahead";
}

/** Empty means the observed state satisfies the desired one. */
export type Drift = ReadonlyArray<DriftField>;

export interface Reconciler<Props, State, E = never, R = never> {
  /**
   * The machine-level identity of what this manages — a filesystem path, a
   * `domain/key` pair, a package name qualified by its manager.
   *
   * Two resources sharing an address contend for the same real thing, so the
   * engine serialises their applies. When {@link snapshotBeforeApply} is set,
   * this is also what gets preserved before the first overwrite.
   */
  readonly address: (props: Props) => string;

  /**
   * Read the live state at {@link address}, or `Option.none()` if nothing is
   * there.
   *
   * This is the only thing that decides whether the machine matches the recipe.
   */
  readonly observe: (
    props: Props,
    ctx: ObserveContext,
  ) => Effect.Effect<Option.Option<State>, E, R>;

  /** The state these props are asking for. */
  readonly desired: (props: Props) => Effect.Effect<State, E, R>;

  /**
   * Whether an observed state already satisfies a desired one.
   *
   * Not equality: desired state is frequently partial. A file that does not
   * pin its mode is satisfied by any mode, so a reconciler compares only what
   * the props actually constrain.
   */
  readonly matches: (observed: State, desired: State) => boolean;

  /**
   * The same judgement as {@link matches}, but reporting which fields differ so
   * a plan can say what changed rather than only that something did.
   *
   * Optional and additive: a reconciler that defines it must agree with its own
   * `matches` (empty exactly when `matches` is true), and one that does not
   * still plans correctly with a reason-less `update`. `toProvider` prefers
   * `drift` when present.
   */
  readonly drift?: (observed: State, desired: State) => Drift;

  /** Converge the machine. Runs only when {@link matches} returned false. */
  readonly apply: (
    input: ApplyInput<Props, State>,
    ctx: ApplyContext,
  ) => Effect.Effect<State, E, R>;

  /**
   * Enumerate every instance of this resource actually present on the
   * machine, in the same shape {@link observe} reports for one. Alchemy's
   * `list` capability — real inventory, not adoption of one already-named
   * address.
   *
   * Optional, and expected to stay unset for most resources today: nothing in
   * this repo implements it yet — see `system-packages/TASKS.md`'s open
   * "Implement `list`" task, which this makes reachable without committing
   * any particular resource to doing it. Leaving it unset and implementing it
   * to return `[]` are different claims: unset says "this reconciler hasn't
   * been taught to enumerate"; an explicit `[]` says "there is provably
   * nothing to enumerate" (an account-wide singleton, a sub-resource keyed
   * entirely by a parent). `toProvider` preserves that distinction — see its
   * doc comment on `list`.
   */
  readonly list?: (ctx: ObserveContext) => Effect.Effect<State[], E, R>;

  /**
   * Preserve pre-existing content at {@link address} before the first apply
   * that could destroy it.
   *
   * Set for anything that overwrites a file a person may have written by hand.
   * The engine decides *when*: on the first apply for this resource, and on the
   * first apply after adopting something that already existed.
   */
  readonly snapshotBeforeApply?: boolean;

  /**
   * Whether finding something at {@link address} that this resource has no record
   * of writing should *refuse* rather than silently take it over.
   *
   * Set it for anything whose content a person may have written by hand. Alchemy
   * routes it: `read` brands its result `Unowned`, and `Plan` then fails with
   * `OwnedBySomeoneElse` unless the run passes `--adopt` (or wraps the effect in
   * `adopt(true)`). The refusal happens at *plan* time, so the operator is told
   * before anything is touched.
   *
   * This is the framework's answer to the failure mode behind four separate
   * data-loss bugs in this repo: a reconciler finding a file it did not write and
   * overwriting it. {@link snapshotBeforeApply} softened that by taking a backup;
   * this prevents it, and they compose — an adopted resource is still backed up
   * before its first write.
   *
   * Left unset where there is no ownership question. A package already installed,
   * or a `defaults` key already set, is fine to adopt: there is no hand-authored
   * content to lose, and demanding `--adopt` for every pre-installed package
   * would make the flag meaningless.
   */
  readonly refuseUnowned?: boolean;

  /**
   * Undo {@link apply}, when doing so is possible and safe. Optional, and
   * expected to stay unset for most resources.
   *
   * `toProvider`'s `delete` only ever calls this under an explicit
   * `RemovalPolicy` of `"destroy"` — see its doc comment for the full
   * reasoning. Leaving `unapply` unset is indistinguishable, from the
   * machine's point of view, from the default `"retain"` policy: both leave
   * whatever this resource manages exactly as it is. That equivalence is
   * deliberate. A resource with nothing safe to undo (most package installs:
   * dependent files, caches and daemon state an uninstall doesn't clean up;
   * a macOS default with no recorded prior value) should not implement this
   * at all, rather than write an `unapply` that only *partially* reverses
   * itself and reports success — a half-undo is worse than a well-documented
   * no-op, because it looks like it worked.
   *
   * `observed` is state freshly read via {@link observe} immediately before
   * this runs — never trusted from `recorded` alone — for the same reason
   * `reconcile` re-observes before applying: the machine may have drifted (or
   * been hand-edited, or already cleaned up) since the last run that touched
   * it, and undoing a stale recollection risks clobbering something this run
   * never actually put there. `unapply` is only called at all when `observed`
   * is defined — nothing to undo is nothing to do.
   *
   * `recorded` is Alchemy's persisted `output` for this resource — the state
   * `apply` returned on the run that last touched it, round-tripped through
   * the state file. It is the *only* place bookkeeping can survive from one
   * run to a much later one: `Backups`' own directory is stamped fresh every
   * run, so a reconciler that wants to restore a real prior value must have
   * captured `ApplyContext.snapshot`'s return path into its own `State` at
   * `apply` time and read it back from `recorded` here. A reconciler that
   * never does that cannot honestly invent a prior value from nothing —
   * removing what it created is the only safe undo left, and even that is
   * only correct when creation is known to be the *sole* effect of `apply`
   * (a package manager's install commonly pulls in transitive dependencies an
   * uninstall may not remove, so "undo" and "restore the exact prior state"
   * are not the same claim).
   */
  readonly unapply?: (
    input: {
      readonly props: Props;
      /** Live state at {@link address}, reread just before this call. */
      readonly observed: State;
      /** Alchemy's persisted state for this resource prior to this destroy. */
      readonly recorded: State;
    },
    ctx: ApplyContext,
  ) => Effect.Effect<void, E, R>;
}
