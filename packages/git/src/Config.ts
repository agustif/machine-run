import { MachinePaths, Sh } from "@machine-run/core";
import { type Exec, type Reconciler, toProvider } from "@machine-run/engine";
import type { CommandError } from "alchemy/Command";
import { Resource } from "alchemy/Resource";
import * as EffectConfig from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { isExitCode } from "./exitCode.ts";

/**
 * One global `git config` key, holding one or more values in the order git
 * should hold them.
 *
 * This is the load-bearing resource in `@machine-run/git`: every other
 * resource in this package that touches `git config` — `Git.Ignore`, `Git.
 * Attributes`, `Git.Alias`, `Git.Signing`, `Git.CredentialHelper`, `Git.
 * HooksPath` — is a composition over this one, never a second way to write a
 * config key.
 *
 * ## Why one prop, not `value: string` and `values: string[]`
 *
 * `credential.helper` is a real, documented multi-valued key — git tries
 * each configured helper in turn — and `includeIf.<condition>.path` entries
 * commonly coexist with a same-named key used only once elsewhere. Giving
 * single- and multi-valued keys two different prop shapes would mean two
 * representations of the same underlying thing (an ordered list of strings)
 * and an ambiguous case when both were supplied. `values` is always an array;
 * a key that only ever holds one value just has a one-element array.
 *
 * ## Convergence, not patching
 *
 * `apply` never inspects what is already there before writing: it always
 * runs `--unset-all` followed by one `--add` per desired value, in order.
 * That is what makes it converge from *any* drifted starting point — extra
 * values, values in the wrong order, a single value where several are
 * wanted — with one code path, rather than needing a diff-and-patch dance
 * over git's own add/replace-all/unset-all primitives. Verified against real
 * git 2.50.1: `--unset-all` on a key that was never set exits `5`, which is
 * treated as success rather than "nothing to unset, abort" — see
 * {@link unsetAll}.
 *
 * The consequence, recorded honestly rather than hidden: because every apply
 * re-appends, changing the *value* of an existing multi-line-relevant key
 * (most notably an `includeIf.<gitdir-glob>.path` entry — see `Git.Signing`'s
 * sibling in `git-identity`'s persona composition) moves its position to the
 * end of the file, not just its content. `ManagedBlock` avoids this by
 * splicing in place; `Git.Config` cannot, because `git config` itself has no
 * "replace in place, keep position" operation. Use {@link
 * GitConfigProps.after} for any pair of keys whose relative order matters,
 * the same way `Dotfiles.ManagedBlockProps.after` does.
 *
 * ## Type normalisation — the hazard this exists to avoid
 *
 * Verified against real git 2.50.1: `git config --global foo.bar yes` stores
 * the literal string `yes`, but `git config --global --get --type=bool
 * foo.bar` prints `true` — and a *valueless* boolean entry (`[foo]\n\tbar`,
 * which a person can write by hand) reads back as the **empty string**
 * without `--type=bool`, and only becomes `true` with it. A naive string
 * comparison between what a recipe asks for and what git echoes back would
 * report drift forever for any of these spellings — the exact class of bug
 * `MacOS.Default` had with `defaults`' plist round-tripping. Setting
 * `type: "bool"` makes both `observe` and `desired` pass `--type=bool`
 * through the *same* canonicalisation (git's own, for reads; {@link
 * canonicalBool}'s hand-written mirror of git's documented boolean literal
 * table, for the desired side, since `desired` has no command-running
 * capability to ask git itself — see `Reconciler.desired`'s signature).
 *
 * Only `"bool"` is implemented. `int`/`bool-or-int` are lower-value here (no
 * composition in this package needs one) and `path`/`color`/`expiry-date`
 * each carry their own hazard that hasn't been designed for:
 * `--type=expiry-date`'s canonical form is a Unix timestamp computed relative
 * to *now*, so it would report drift on every single plan even with no real
 * change; `--type=color` emits a raw ANSI escape sequence; `--type=path`
 * expands `~` at *read* time only, so a value stored as `~/x` and a value
 * stored as the already-expanded absolute path would compare unequal despite
 * meaning the same thing on this machine. `Git.Ignore`/`Git.Attributes`/
 * `Git.Signing`/`Git.HooksPath` sidestep the last one entirely by writing
 * already-`MachinePaths`-expanded absolute paths as plain strings.
 *
 * ## Scope: always `--global`
 *
 * Every command here passes `--global` explicitly. There is no `scope` prop
 * — a resource for repository-local config would need a `cwd`/`gitDir` prop
 * and a different address (per-repo, not per-machine), which is a distinct
 * resource, not a variant of this one.
 */
/**
 * Which of git's `--type` normalisations, if any, a key's values should be
 * canonicalised through before comparing — see this module's doc comment
 * for why only `"bool"` is implemented today.
 */
export const GitConfigType = Schema.Literals(["bool"]);
export type GitConfigType = typeof GitConfigType.Type;

export const GitConfigProps = Schema.Struct({
  /** A `git config` key, e.g. `"user.name"` or `"credential.helper"`. */
  key: Schema.String,
  /**
   * The value(s) this key should hold, in order. Most keys hold exactly one;
   * `credential.helper` and `includeIf.<cond>.path`-shaped keys can
   * legitimately hold several across different resources.
   */
  values: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  /**
   * When set to `"bool"`, both observation and desired-state computation
   * canonicalise through git's boolean literal table before comparing — see
   * this module's doc comment. Omit it for a key whose value is compared as
   * an ordinary string.
   */
  type: Schema.optionalKey(GitConfigType),
  /**
   * Forces this key to be written after another one — see {@link
   * Dotfiles.ManagedBlockProps.after} in `@machine-run/dotfiles`, which this
   * mirrors exactly. Pass another `Git.Config` call's `values`; the value is
   * never read, only referenced, which is what builds the Alchemy dependency
   * edge that determines application order under `concurrency: "unbounded"`.
   */
  after: Schema.optionalKey(Schema.Array(Schema.String)),
});

export type GitConfigProps = typeof GitConfigProps.Type;

/**
 * `values` mirrors {@link GitConfigProps.values} but always canonicalised —
 * see {@link GitConfigType} — so `observe` and `desired` are directly
 * comparable regardless of how the value was originally spelled or written.
 */
export const GitConfigState = Schema.Struct({
  key: Schema.String,
  values: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
});

export type GitConfigState = typeof GitConfigState.Type;

export interface Config extends Resource<"Git.Config", GitConfigProps, GitConfigState> {}

export const Config = Resource<Config>("Git.Config");

/**
 * A `values` entry is not one of git's documented boolean literals.
 *
 * Raised from `desired`, before any command runs — the canonical table
 * (`man git-config`'s "Values" section, verified against real git 2.50.1) is
 * `yes`/`on`/`true`/`1` for true and `no`/`off`/`false`/`0`/`""` for false,
 * case-insensitively. `git config --type=bool` itself would reject anything
 * else with `fatal: bad boolean config value`; this fails the same way but
 * earlier, and without needing a command to do it.
 */
export class GitConfigInvalidBoolean extends Data.TaggedError("GitConfigInvalidBoolean")<{
  key: string;
  value: string;
}> {
  override get message() {
    return `"${this.value}" for git config key "${this.key}" is not one of git's boolean literals (yes/on/true/1 for true, no/off/false/0/"" for false, case-insensitively). Spell it as one of those, or drop \`type: "bool"\` to store the literal string.`;
  }
}

/**
 * `git config` failed for a reason other than the ordinary "no such key" (on
 * read) or "nothing to unset" (before a write) — a malformed key, a corrupt
 * config file, git itself missing, or anything else. Classifying a `git`
 * failure by exit code is the documented contract (`man git-config`'s "FILES"
 * section enumerates them), not string-matching stderr, so this stays
 * reliable across git versions and locales.
 */
export class GitConfigCommandFailed extends Data.TaggedError("GitConfigCommandFailed")<{
  key: string;
  cause: CommandError;
}> {
  override get message() {
    return `git config failed for "${this.key}": ${this.cause.message}`;
  }
}

export type GitConfigError = GitConfigInvalidBoolean | GitConfigCommandFailed;

/** Git's documented case-insensitive boolean literals (`man git-config`, "Values"). */
const TRUE_LITERALS = new Set(["yes", "on", "true", "1"]);
const FALSE_LITERALS = new Set(["no", "off", "false", "0", ""]);

/**
 * Mirrors `git config --type=bool`'s canonicalisation, for the side that has
 * no command to ask git directly (`desired`, see this module's doc comment).
 * Returns `Result` rather than failing an `Effect` because this is a pure,
 * total classification with no command involved.
 */
export const canonicalBool = (
  key: string,
  value: string,
): Result.Result<string, GitConfigInvalidBoolean> => {
  const lower = value.toLowerCase();
  if (TRUE_LITERALS.has(lower)) return Result.succeed("true");
  if (FALSE_LITERALS.has(lower)) return Result.succeed("false");
  return Result.fail(new GitConfigInvalidBoolean({ key, value }));
};

const typeFlag = (type: GitConfigProps["type"]): readonly string[] =>
  type === undefined ? [] : [`--type=${type}`];

/**
 * Splits `--get-all -z` output into its values.
 *
 * `-z` NUL-terminates every value, including embedded literal newlines
 * (verified: `git config --global multiline.key "$(printf 'a\\nb')"` then
 * `--get -z` yields `a\nb\0`, one value, not two) — the newline-delimited
 * default would misparse exactly that case. Splitting on `\0` leaves one
 * trailing empty string from the final terminator, which is not a value.
 */
const splitNulTerminated = (stdout: string): readonly string[] => {
  const parts = stdout.split("\0");
  return parts.slice(0, -1);
};

/**
 * Reads every value of `key` from the global config, or `undefined` when the
 * key is unset.
 *
 * Verified against real git 2.50.1: `--get-all` on an unset key exits `1`
 * with empty output; git's own docs concede exit `1` is shared with "the
 * section or key is invalid" (`man git-config`, "FILES"), so a genuinely
 * malformed `key` prop is indistinguishable from "absent" here. It surfaces
 * for real once `apply` tries to *write* it — `git config --global <bad key>
 * <value>` exits `2`, a code reserved for real errors, which {@link
 * unsetAll}/`addOne` propagate as {@link GitConfigCommandFailed} rather than
 * swallowing.
 */
const getAll = (
  key: string,
  type: GitConfigProps["type"],
  exec: Exec,
): Effect.Effect<readonly string[] | undefined, GitConfigCommandFailed> =>
  exec({
    command: Sh.sh("git", "config", "--global", "--get-all", "-z", ...typeFlag(type), key),
    shell: true,
  }).pipe(
    Effect.map((result) => splitNulTerminated(result.stdout)),
    Effect.catch((error) =>
      isExitCode(error, 1)
        ? Effect.succeed(undefined)
        : Effect.fail(new GitConfigCommandFailed({ key, cause: error })),
    ),
  );

/**
 * Clears every existing value of `key`, tolerating "there was nothing to
 * clear".
 *
 * Verified: `--unset-all` on a key that was never set exits `5` — the same
 * code git uses for "multiple values match an unset/set with no
 * disambiguation" (`man git-config`, "FILES"), so this treats *any* exit `5`
 * as "already absent" rather than trying to tell the two apart. That's safe
 * here specifically because `--unset-all` (not a bare `--unset`) never
 * declines to act just because there were several values.
 */
const unsetAll = (key: string, exec: Exec): Effect.Effect<void, GitConfigCommandFailed> =>
  exec({
    command: Sh.sh("git", "config", "--global", "--unset-all", key),
    shell: true,
  }).pipe(
    Effect.asVoid,
    Effect.catch((error) =>
      isExitCode(error, 5)
        ? Effect.void
        : Effect.fail(new GitConfigCommandFailed({ key, cause: error })),
    ),
  );

/** Appends one value to `key`, preserving whatever is already there. */
const addOne = (
  key: string,
  type: GitConfigProps["type"],
  value: string,
  exec: Exec,
): Effect.Effect<void, GitConfigCommandFailed> =>
  exec({
    command: Sh.sh("git", "config", "--global", ...typeFlag(type), "--add", key, value),
    shell: true,
  }).pipe(
    Effect.asVoid,
    Effect.catch((error) => Effect.fail(new GitConfigCommandFailed({ key, cause: error }))),
  );

/**
 * Resolves the file `git config --global` actually reads and writes, once,
 * for use as every `Git.Config` resource's shared {@link Reconciler.address}.
 *
 * Verified against real git 2.50.1: with neither candidate file present,
 * `--global` writes to `~/.gitconfig`; but when `$XDG_CONFIG_HOME/git/config`
 * (or `~/.config/git/config` if `$XDG_CONFIG_HOME` is unset) already exists —
 * even empty — `--global` writes *there* instead, regardless of whether
 * `~/.gitconfig` also exists. This mirrors that one rule (computed once, not
 * per apply, since {@link Reconciler.address} is a plain synchronous
 * function of props with no I/O capability). It is a heuristic, not a
 * guarantee: if something creates the XDG file mid-run after this resolves,
 * or if a future git version changes the precedence, the address computed
 * here can diverge from the file git actually touches, which would weaken
 * both the shared `FileLock` exclusion this address exists to provide (see
 * `@machine-run/core`'s `FileLock` — verified separately that 20 of 30
 * concurrent `git config --global` writers to one file failed with `could
 * not lock config file ...: File exists`, so serialising on *some* address is
 * not optional) and the pre-write `Backups.snapshot`. Recorded as a known gap
 * in `docs/git-notes.md` rather than hidden.
 */
const resolveGlobalConfigPath = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  paths: typeof MachinePaths.Service,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const xdgConfigHome = yield* EffectConfig.option(EffectConfig.string("XDG_CONFIG_HOME")).pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    const xdgBase = Option.getOrElse(xdgConfigHome, () => path.join(paths.home, ".config"));
    const xdgConfig = path.join(xdgBase, "git", "config");
    const xdgExists = yield* fs.exists(xdgConfig).pipe(Effect.orElseSucceed(() => false));
    return xdgExists ? xdgConfig : path.join(paths.home, ".gitconfig");
  });

export const makeGitConfigReconciler: Effect.Effect<
  Reconciler<GitConfigProps, GitConfigState, GitConfigError>,
  never,
  FileSystem.FileSystem | Path.Path | MachinePaths
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* MachinePaths;
  const globalConfigPath = yield* resolveGlobalConfigPath(fs, path, paths);

  /** Canonicalises `values` the same way `--type=bool` would on read, for `desired`. */
  const canonicalize = (
    key: string,
    type: GitConfigProps["type"],
    values: readonly string[],
  ): Result.Result<readonly string[], GitConfigInvalidBoolean> => {
    if (type !== "bool") return Result.succeed(values);
    const canonical: string[] = [];
    for (const value of values) {
      const result = canonicalBool(key, value);
      // Re-wrapped rather than returned as-is: `Failure<string, E>` and
      // `Failure<readonly string[], E>` carry the same value but are
      // different types (same reasoning as `macos-defaults`' `Value.ts`).
      if (Result.isFailure(result)) return Result.fail(result.failure);
      canonical.push(result.success);
    }
    return Result.succeed(canonical);
  };

  return {
    // Every key lives in the same one global file, and git's own file lock
    // does not survive concurrent writers (verified above) — so every
    // Git.Config resource, regardless of key, shares one address and
    // therefore one FileLock, matching Dotfiles.ManagedBlock's per-file
    // (not per-region) granularity for the same reason.
    address: () => globalConfigPath,
    snapshotBeforeApply: true,

    observe: (props, ctx) =>
      Effect.gen(function* () {
        const values = yield* getAll(props.key, props.type, ctx.exec);
        return values === undefined ? undefined : { key: props.key, values };
      }),

    desired: (props) =>
      Effect.gen(function* () {
        const canonical = canonicalize(props.key, props.type, props.values);
        if (Result.isFailure(canonical)) {
          return yield* Effect.fail(canonical.failure);
        }
        return { key: props.key, values: canonical.success };
      }),

    matches: (observed, desired) =>
      observed.key === desired.key &&
      observed.values.length === desired.values.length &&
      observed.values.every((value, index) => value === desired.values[index]),

    apply: ({ props, desired }, ctx) =>
      Effect.gen(function* () {
        yield* unsetAll(props.key, ctx.exec);
        for (const value of desired.values) {
          yield* addOne(props.key, props.type, value, ctx.exec);
        }
        return desired;
      }),
  };
});

export const ConfigProvider = () => toProvider(Config, makeGitConfigReconciler);
