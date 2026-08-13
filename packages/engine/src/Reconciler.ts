import type { CommandRunProps } from "alchemy/Command";
import type { CommandError } from "alchemy/Command";
import type * as Effect from "effect/Effect";

/**
 * The output of a command, as `CommandExecutor` returns it.
 */
export interface CommandOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs a command and returns its output.
 *
 * Which status session the command reports to is bound by the engine, per
 * phase, so nothing downstream has to know a session exists.
 */
export type Exec = (
  props: CommandRunProps,
) => Effect.Effect<CommandOutput, CommandError>;

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
}

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
   * Live state as observed immediately beforehand, or `undefined` when there
   * is nothing at this address yet. Reconcilers converge from what is actually
   * there rather than from what was recorded, so an apply that resumes after a
   * partial failure sees the truth.
   */
  readonly observed: State | undefined;
  /** What {@link Reconciler.desired} computed for these props. */
  readonly desired: State;
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
   * Read the live state at {@link address}, or `undefined` if nothing is there.
   *
   * This is the only thing that decides whether the machine matches the recipe.
   */
  readonly observe: (
    props: Props,
    ctx: ObserveContext,
  ) => Effect.Effect<State | undefined, E, R>;

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

  /** Converge the machine. Runs only when {@link matches} returned false. */
  readonly apply: (
    input: ApplyInput<Props, State>,
    ctx: ApplyContext,
  ) => Effect.Effect<State, E, R>;

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
