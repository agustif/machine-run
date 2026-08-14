import { MachinePaths, Sh } from "@machine-run/core";
import { type ObserveContext, type Reconciler, toProvider } from "@machine-run/engine";
import type { CommandError } from "alchemy/Command";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { type PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";

/**
 * Raised when neither {@link ExecProps.unless} nor {@link ExecProps.creates}
 * is set.
 *
 * Without one, there is nothing to observe: every plan would see "not yet
 * done" and every apply would run `command` again, unconditionally — a
 * resource in name only, no different from a shell script line. That is not
 * automatically wrong (some commands *are* their own guard — `mkdir -p`,
 * `brew update`), but it must be deliberate, and it must say so at the call
 * site rather than being inferred from the *absence* of a guard, which reads
 * identically to forgetting one. Anyone who genuinely wants "run every time"
 * can say `unless: "false"` (a command that always exits non-zero) — that is
 * both a real guard and a self-documenting one.
 */
export class ExecGuardRequired extends Data.TaggedError("ExecGuardRequired")<{
  command: string;
}> {
  override get message() {
    return `Machine.Exec for "${this.command}" sets neither "unless" nor "creates", so there is no way to tell whether it has already run. Add one, or if the command is meant to run unconditionally on every apply, say so explicitly with unless: "false".`;
  }
}

/**
 * Runs a shell command as an escape hatch for anything the other `dotfiles`
 * primitives don't model — installing a tool with its own installer script,
 * running a one-off migration, anything whose result isn't a file this tool
 * can hash.
 *
 * `command` is passed to the shell exactly as written (`shell: true`): unlike
 * every other resource here, this one's entire purpose is to run an
 * arbitrary command the recipe author wrote, so there is no template to
 * protect against a hostile *value* being interpolated into it (contrast
 * `Sh.sh(...)`, which exists because other resources build a command string
 * out of prop values the recipe author does not fully control the shape of).
 * The recipe author is trusted with their own `command` string, the same way
 * they are trusted with the rest of the recipe.
 *
 * ## Resource, not Action
 *
 * Alchemy's `Action` (`alchemy/src/Action.ts`) is a graph node with no
 * provider lifecycle, whose body re-runs when its resolved `Input` changes or
 * `--force` is passed — it reacts to the *recipe* changing, never to the
 * machine. `Machine.Exec`'s entire job is the opposite: decide whether to run
 * by checking live state (`unless`/`creates`) on every plan, the same
 * observe-versus-desire contract every other resource here honours. Modelling
 * it as an `Action` would make it blind to the machine between prop changes —
 * exactly the "compares against its own last output" failure mode
 * `docs/ARCHITECTURE.md` documents `File`/`ManagedBlock` having fixed. If a
 * future need is genuinely "re-run only when these inputs change, and I don't
 * care what's on the machine", that is a real `Action` use case — but it is a
 * different primitive from this one, not a variant of it.
 */
export const ExecProps = Schema.Struct({
  /** Command to run, exactly as a person would type it at a shell prompt. */
  command: Schema.String,
  /**
   * A command whose success (exit `0`) means `command` has already run.
   *
   * Evaluated during `observe`, which runs during planning — before the
   * operator has agreed to change anything — so this command **must be
   * read-only**. `ctx.exec` cannot enforce that; it is a contract on
   * whatever is written here.
   */
  unless: Schema.optionalKey(Schema.String),
  /** A path (`~` expanded) whose existence means `command` has already run. */
  creates: Schema.optionalKey(Schema.String),
  /** Working directory for `command` (and for `unless`, if set). `~` is expanded. */
  cwd: Schema.optionalKey(Schema.String),
  /**
   * Extra environment variables for `command`.
   *
   * Plain strings only, and deliberately so: props are persisted into
   * Alchemy's state file as unencrypted JSON (see `Machine.File`'s doc
   * comment for the same rule), so nothing secret can go here. A command
   * that needs a secret needs it supplied some other way.
   */
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

export type ExecProps = typeof ExecProps.Type;

/**
 * Whether the guard(s) currently report `command` as already having run.
 * There is no other live state to observe for an arbitrary command, so this
 * *is* the observation — analogous to `Machine.File`'s content hash.
 */
export const ExecState = Schema.Struct({
  satisfied: Schema.Boolean,
});

export type ExecState = typeof ExecState.Type;

export interface Exec extends Resource<"Machine.Exec", ExecProps, ExecState> {}

export const Exec = Resource<Exec>("Machine.Exec");

export const makeExecReconciler: Effect.Effect<
  Reconciler<ExecProps, ExecState, CommandError | ExecGuardRequired | PlatformError>,
  never,
  FileSystem.FileSystem | MachinePaths
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* MachinePaths;

  /**
   * Evaluates every guard the props set and requires all of them to agree
   * `command` has already run. Shared between `observe` (planning) and
   * `apply` (to report the state actually reached after running `command`,
   * rather than optimistically claiming success).
   *
   * Does not itself check for "no guard at all" — `observe` raises
   * {@link ExecGuardRequired} for that, since it is a property of the props
   * alone rather than something worth re-deriving here.
   */
  const evaluateGuard = (
    props: ExecProps,
    ctx: ObserveContext,
  ): Effect.Effect<boolean, CommandError | PlatformError> =>
    Effect.gen(function* () {
      if (props.creates !== undefined) {
        // A genuine failure to check (a permissions problem on a parent
        // directory, say) is surfaced rather than read as "not created yet" —
        // collapsing the two would let a real problem masquerade as normal
        // not-done-yet drift, forever.
        const exists = yield* fs.exists(paths.expand(props.creates));
        if (!exists) return false;
      }

      if (props.unless !== undefined) {
        const succeeded = yield* ctx
          .exec({
            // `Machine.Exec` runs an operator-authored shell command by
            // design — that is its entire purpose, not a value being
            // interpolated into a fixed command shape. See `Sh.unsafeRaw`'s
            // doc comment for the two cases this covers.
            command: Sh.unsafeRaw(
              props.unless,
              "Machine.Exec runs operator-authored shell by design",
            ),
            shell: true,
            ...(props.cwd !== undefined ? { cwd: paths.expand(props.cwd) } : {}),
          })
          .pipe(
            Effect.as(true),
            // A non-zero exit from `unless` is its ordinary "not done yet"
            // signal, not a failure to run it — the same convention
            // make/Ansible-style guards use. Best-effort by necessity:
            // there is no way to distinguish "genuinely not done" from "the
            // guard command itself is broken" from an exit code alone.
            Effect.catchTag("CommandError", () => Effect.succeed(false)),
          );
        if (!succeeded) return false;
      }

      return true;
    });

  return {
    address: (props) =>
      props.creates !== undefined
        ? paths.expand(props.creates)
        : // No path to key off: the closest available identity for an
          // arbitrary command is the command itself, qualified by `cwd`
          // (the same string in two different directories is not the same
          // real action).
          `exec:${props.cwd ?? ""}:${props.command}`,

    // Always `Option.some`: whether the guard(s) report `command` as already
    // run is itself the observation (see `ExecState`'s doc comment), so there
    // is no "nothing here yet" case distinct from `satisfied: false` for this
    // resource to signal.
    observe: (props, ctx) =>
      Effect.gen(function* () {
        if (props.unless === undefined && props.creates === undefined) {
          return yield* Effect.fail(new ExecGuardRequired({ command: props.command }));
        }
        return Option.some({ satisfied: yield* evaluateGuard(props, ctx) });
      }),

    desired: () => Effect.succeed({ satisfied: true }),

    matches: (observed, desired) => observed.satisfied === desired.satisfied,

    apply: ({ props }, ctx) =>
      Effect.gen(function* () {
        yield* ctx.exec({
          // Same escape hatch as `unless` above — this resource's entire job
          // is running an arbitrary, operator-authored command.
          command: Sh.unsafeRaw(
            props.command,
            "Machine.Exec runs operator-authored shell by design",
          ),
          shell: true,
          ...(props.cwd !== undefined ? { cwd: paths.expand(props.cwd) } : {}),
          ...(props.env !== undefined ? { env: props.env } : {}),
        });

        // Re-evaluates the guard rather than assuming success, so the
        // recorded state honestly reflects the machine: if `command`
        // succeeded but the guard still reports "not done" (a mismatch
        // between what the guard checks and what the command actually
        // does), the next plan sees that too, instead of a state file
        // claiming convergence that never happened.
        return { satisfied: yield* evaluateGuard(props, ctx) };
      }),
  };
});

export const ExecProvider = () => toProvider(Exec, makeExecReconciler);
