import {
  detectLineEnding,
  ensureParentDir,
  joinLines,
  MachinePaths,
  makeSha256,
  readIfPresent,
  splitLines,
} from "@machine-run/core";
import { type Drift, type DriftField, type Reconciler, toProvider } from "@machine-run/engine";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Crypto from "effect/Crypto";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { PlatformError } from "effect/PlatformError";
import { Position } from "./ManagedBlock.ts";

/**
 * A single line inside a file this tool does not own outright — `/etc/hosts`,
 * a lone `export` a person's `~/.zshrc` also carries hand-written lines
 * around, a one-line systemd drop-in. Narrower than {@link ManagedBlock}: no
 * marker comments wrap the line, so the file reads exactly as if a person had
 * hand-edited a single line of it and left everything else untouched.
 *
 * ## Identity: `match`, not a marker
 *
 * `ManagedBlock` knows which text is "its" region because it wrote explicit
 * BEGIN/END comment markers around it. A bare line has nothing to wrap it in,
 * so this resource is told how to *recognise* the line instead: `match` is a
 * JavaScript regular expression (no flags — it is tested against each line of
 * the file individually, so `^`/`$` anchor to that one line) that should
 * identify exactly the line this resource owns, wherever it currently sits.
 *
 * - **Zero matching lines** means the line has never been written (or was
 *   removed by hand); `apply` inserts `line` per {@link position}.
 * - **Exactly one matching line** is this resource's line; `apply` replaces
 *   just that line, in place, leaving every other line untouched.
 * - **More than one matching line** is refused, in both `observe` and
 *   `apply` — see {@link LineInFileMalformed}. There is no safe default:
 *   picking "the first one" would silently ignore hand-written duplicates
 *   this resource does not own, and picking "the last" is no more
 *   principled. This is the same judgement `ManagedBlock.renderFile` makes
 *   for a file carrying a duplicated marker pair (`docs/../ManagedBlock.ts`),
 *   applied to a match that was ambiguous from the very first line rather
 *   than one that became ambiguous through corruption.
 *
 * `match` must also match `line` itself — checked at both `desired` and
 * `apply` time — or the line this resource writes could never be found again
 * on a later run, and every apply would insert a fresh copy rather than
 * converging (see {@link renderLine}).
 *
 * ## When to reach for `ManagedBlock` instead
 *
 * This resource is for a file where a single, recognisable, syntactically
 * self-contained line is genuinely the right unit — a `PATH=` assignment in
 * `/etc/environment`, a `127.0.0.1 name` entry in `/etc/hosts`. It is the
 * wrong tool the moment ownership needs to span more than one line (a
 * multi-line stanza, several related settings that should move together) or
 * the moment two independently-changing pieces of content could plausibly
 * land on the same regex — both are exactly what `ManagedBlock`'s explicit
 * markers exist to make unambiguous. Two overlapping ways to edit "one line
 * in a file" is a real cost: a recipe author who reaches for this resource
 * out of habit where `ManagedBlock` was actually called for gets no marker
 * comments explaining, to whoever reads the file by hand later, why that line
 * is there or that something manages it at all.
 */
export const LineInFileProps = Schema.Struct({
  /** Path to the file. `~` is expanded. */
  path: Schema.String,
  /**
   * A regular expression (source only, no flags — e.g. `"^127\\.0\\.0\\.1 "`),
   * tested against each line of the file independently to find the one this
   * resource owns.
   */
  match: Schema.String,
  /** The line's desired full text, without a trailing newline. Must itself satisfy `match`. */
  line: Schema.String,
  /**
   * Where a *new* line is inserted when nothing yet matches. `"append"`
   * (default) places it at the end; `"prepend"` places it at the top, for
   * formats where an earlier line can shadow a later one (mirrors
   * `ManagedBlockProps.position`).
   */
  position: Schema.optionalKey(Position),
  /** POSIX mode for directories created to hold this file. */
  directoryMode: Schema.optionalKey(Schema.Number),
});

export type LineInFileProps = typeof LineInFileProps.Type;

/**
 * `hash` is of the line's own text, so a hand-edit to just that line is
 * detected as drift the same way `ManagedBlock`'s region hash is.
 */
export const LineInFileState = Schema.Struct({
  path: Schema.String,
  match: Schema.String,
  hash: Schema.String,
});

export type LineInFileState = typeof LineInFileState.Type;

export interface LineInFile extends Resource<
  "Machine.LineInFile",
  LineInFileProps,
  LineInFileState
> {}

export const LineInFile = Resource<LineInFile>("Machine.LineInFile");

/**
 * Raised when `match` cannot be resolved to exactly one line to act on — it
 * matches more than one existing line, or the desired `line` does not satisfy
 * `match` itself.
 *
 * Both are the same underlying problem: `match` no longer unambiguously names
 * "the line" this resource owns. Guessing (first match, last match, ignore
 * the mismatch) trades a loud, fixable error now for silent, compounding
 * duplication on every later apply — the same reasoning
 * `ManagedBlockMalformed` gives for a marker pair that doesn't line up.
 */
export class LineInFileMalformed extends Data.TaggedError("LineInFileMalformed")<{
  path: string;
  match: string;
  detail: string;
}> {
  override get message() {
    return `Machine.LineInFile for /${this.match}/ in "${this.path}" cannot proceed: ${this.detail}. Narrow "match", or use Machine.ManagedBlock if this file needs more than one related line under management.`;
  }
}

/**
 * Raised when {@link LineInFileProps.path} cannot be read at all — a
 * permissions problem, an I/O error — as distinct from "the file does not
 * exist yet", which is an ordinary state to converge from (no line yet, so
 * `apply` inserts one). `LineInFile` exists specifically for files this tool
 * does not own outright — `/etc/hosts`, a lone line in `~/.zshrc` — so
 * collapsing an unreadable file into "empty" would make `apply` insert its
 * line into what it treats as a fresh file, discarding everything already
 * there that it simply could not see.
 */
export class LineInFileUnreadable extends Data.TaggedError("LineInFileUnreadable")<{
  path: string;
  cause: PlatformError;
}> {
  override get message() {
    return `Could not read "${this.path}": ${this.cause.reason._tag}.`;
  }
}

/** Every line in `lines` that `matchSource` matches, tested one line at a time. */
const findMatches = (lines: ReadonlyArray<string>, matchSource: string): ReadonlyArray<string> => {
  const regex = new RegExp(matchSource);
  return lines.filter((line) => regex.test(line));
};

/**
 * The current text of the line this resource owns, or `undefined` when no
 * line in `existing` matches `matchSource` yet.
 *
 * Reading the line back — rather than trusting a remembered hash — is what
 * makes drift on that one line detectable, the same reason
 * `ManagedBlock.readBlock` re-reads the file instead of comparing against its
 * own last write.
 */
export const readLine = (
  existing: string,
  matchSource: string,
): Result.Result<string | undefined, { detail: string }> => {
  const found = findMatches(splitLines(existing), matchSource);
  if (found.length > 1) {
    return Result.fail({
      detail: `${found.length} lines match this pattern, so which one this resource owns is ambiguous`,
    });
  }
  // `found[0]` rather than `found.length === 0 ? undefined : ...`: with
  // exactly zero or one element here, this is `undefined` in precisely the
  // "no line yet" case, and the real line's text otherwise.
  return Result.succeed(found[0]);
};

export interface RenderLineOptions {
  readonly position?: Position | undefined;
}

/**
 * Replaces, or inserts, the single line this resource owns within `existing`.
 *
 * Returns a {@link Result} rather than throwing, so an ambiguous match or a
 * self-defeating `match`/`line` pair is an ordinary value the caller handles,
 * and this stays a total function testable without a runtime (mirrors
 * `ManagedBlock.renderFile`).
 */
export const renderLine = (
  existing: string,
  matchSource: string,
  line: string,
  options: RenderLineOptions = {},
): Result.Result<string, { detail: string }> => {
  const regex = new RegExp(matchSource);
  if (!regex.test(line)) {
    return Result.fail({
      detail:
        'the desired line does not itself satisfy "match", so a later plan could never find it again and would insert a duplicate on every apply',
    });
  }

  const lines = splitLines(existing);
  const found = findMatches(lines, matchSource);
  if (found.length > 1) {
    return Result.fail({
      detail: `${found.length} lines match this pattern, so which one to replace is ambiguous`,
    });
  }

  // The file's own convention, preserved rather than overwritten — see
  // `LineEndings.ts`'s doc comment. `existing` being empty (a brand-new file)
  // reports "lf" here too, which is this module's chosen default for content
  // created from nothing.
  const ending = detectLineEnding(existing);

  if (found.length === 1) {
    // Replaces by re-testing each line, rather than by an index computed
    // separately, so there is no index arithmetic that could drift from
    // `found`'s own count.
    const updated = lines.map((candidate) => {
      if (regex.test(candidate)) return line;
      return candidate;
    });
    return Result.succeed(joinLines(updated, ending));
  }

  if (options.position === "prepend") {
    return Result.succeed(joinLines([line, ...lines], ending));
  }
  return Result.succeed(joinLines([...lines, line], ending));
};

/**
 * The inverse of {@link renderLine}: removes the one line `match` finds,
 * leaving every other line untouched. A no-op — not a failure — when no
 * line matches.
 *
 * Same ambiguity guard as `renderLine`: more than one candidate means which
 * line to remove is no more decidable here than which one to replace.
 */
export const removeLine = (
  existing: string,
  matchSource: string,
): Result.Result<string, { detail: string }> => {
  const regex = new RegExp(matchSource);
  const lines = splitLines(existing);
  const found = findMatches(lines, matchSource);
  if (found.length > 1) {
    return Result.fail({
      detail: `${found.length} lines match this pattern, so which one to remove is ambiguous`,
    });
  }
  if (found.length === 0) return Result.succeed(existing);
  return Result.succeed(
    joinLines(
      lines.filter((candidate) => !regex.test(candidate)),
      detectLineEnding(existing),
    ),
  );
};

export const makeLineInFileReconciler: Effect.Effect<
  Reconciler<
    LineInFileProps,
    LineInFileState,
    PlatformError | LineInFileMalformed | LineInFileUnreadable
  >,
  never,
  FileSystem.FileSystem | Path.Path | MachinePaths | Crypto.Crypto
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* MachinePaths;
  const sha256 = yield* makeSha256;

  // Same reasoning as `ManagedBlock`: a missing file contains no matching
  // line, which is indistinguishable here from an existing file that contains
  // none.
  const readFileOrEmpty = (target: string) =>
    readIfPresent(fs, target, (cause) => new LineInFileUnreadable({ path: target, cause })).pipe(
      Effect.map(Option.getOrElse(() => "")),
    );

  return {
    address: (props) => paths.expand(props.path),
    snapshotBeforeApply: true,
    // owns one line in a file it does not own.
    refuseUnowned: true,

    observe: (props) =>
      Effect.gen(function* () {
        const target = paths.expand(props.path);
        const existing = yield* readFileOrEmpty(target);
        const found = readLine(existing, props.match);
        if (Result.isFailure(found)) {
          return yield* Effect.fail(
            new LineInFileMalformed({
              path: target,
              match: props.match,
              detail: found.failure.detail,
            }),
          );
        }
        if (found.success === undefined) return Option.none();
        return Option.some({
          path: target,
          match: props.match,
          hash: yield* sha256(found.success),
        });
      }),

    desired: (props) =>
      Effect.gen(function* () {
        const target = paths.expand(props.path);
        // A `line` that doesn't satisfy its own `match` is caught here too,
        // before `apply` ever touches the filesystem — `renderLine` runs the
        // same check against an empty file, which is enough to evaluate it
        // independent of what's on disk.
        const selfCheck = renderLine("", props.match, props.line, props);
        if (Result.isFailure(selfCheck)) {
          return yield* Effect.fail(
            new LineInFileMalformed({
              path: target,
              match: props.match,
              detail: selfCheck.failure.detail,
            }),
          );
        }
        return { path: target, match: props.match, hash: yield* sha256(props.line) };
      }),

    matches: (observed, desired) =>
      observed.path === desired.path &&
      observed.match === desired.match &&
      observed.hash === desired.hash,

    drift: (observed, desired): Drift => {
      const fields: DriftField[] = [];
      if (observed.path !== desired.path) {
        fields.push({ field: "path", observed: observed.path, desired: desired.path });
      }
      if (observed.match !== desired.match) {
        fields.push({ field: "match", observed: observed.match, desired: desired.match });
      }
      if (observed.hash !== desired.hash) {
        fields.push({ field: "content", observed: observed.hash, desired: desired.hash });
      }
      return fields;
    },

    apply: ({ props, desired }) =>
      Effect.gen(function* () {
        const target = desired.path;
        yield* ensureParentDir(fs, path, target, props.directoryMode);

        const existing = yield* readFileOrEmpty(target);
        const rendered = renderLine(existing, props.match, props.line, props);
        if (Result.isFailure(rendered)) {
          return yield* Effect.fail(
            new LineInFileMalformed({
              path: target,
              match: props.match,
              detail: rendered.failure.detail,
            }),
          );
        }

        yield* fs.writeFileString(target, rendered.success);
        return desired;
      }),

    // Owns only its one line, never the rest of the file — "undo" removes
    // just that line, the same scoping `ManagedBlock.unapply` uses for its
    // region.
    unapply: ({ props, observed }) =>
      Effect.gen(function* () {
        const target = observed.path;
        const existing = yield* readFileOrEmpty(target);
        const removed = removeLine(existing, props.match);
        if (Result.isFailure(removed)) {
          return yield* Effect.fail(
            new LineInFileMalformed({
              path: target,
              match: props.match,
              detail: removed.failure.detail,
            }),
          );
        }
        yield* fs.writeFileString(target, removed.success);
      }),
  };
});

export const LineInFileProvider = () => toProvider(LineInFile, makeLineInFileReconciler);
