import {
  detectLineEnding,
  LineEndingChars,
  MachinePaths,
  makeSha256,
  readIfPresent,
  splitLines,
} from "@machine-run/core";
import { type Drift, type DriftField, type Reconciler, toProvider } from "@machine-run/engine";
import { Resource } from "alchemy/Resource";
import * as Boolean from "effect/Boolean";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Crypto from "effect/Crypto";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** Where a new region is inserted relative to existing file content. */
export const Position = Schema.Literals(["append", "prepend"]);
export type Position = typeof Position.Type;

/**
 * A marker-delimited region inside a file this tool does not own — `~/.zshrc`,
 * `~/.gitconfig`, `~/.ssh/config` and the like, which carry substantial
 * hand-written content. Only the text between the region's BEGIN and END
 * markers is ever rewritten; the rest of the file is preserved byte for byte.
 *
 * ## Ordering between regions in one file
 *
 * Alchemy reconciles resources concurrently, so the relative order of two
 * regions in one file is not determined unless one depends on the other. That
 * matters because the formats disagree about which occurrence wins:
 * `~/.gitconfig` takes the **last** matching `includeIf`, `~/.ssh/config` takes
 * the **first** matching keyword, and `~/.zshrc` simply executes top to bottom.
 * A narrow git persona must land after a broad one, while an ssh catch-all must
 * land after the specific hosts. Use {@link ManagedBlockProps.after} to state
 * the relationship rather than relying on declaration order.
 */
export const ManagedBlockProps = Schema.Struct({
  /** Path to the file. `~` is expanded. */
  path: Schema.String,
  /** Identifies this region within the file; must be stable across runs. */
  marker: Schema.String,
  /** Desired content of the region, excluding the marker lines themselves. */
  content: Schema.String,
  /**
   * Comment syntax for the marker lines. Defaults to `#`, which suits shell,
   * git and ssh config. Set it for formats that comment differently — `//` for
   * jsonc, `;` for ini, `"` for vimrc, `--` for lua.
   */
  commentPrefix: Schema.optionalKey(Schema.String),
  /**
   * Where a *new* region is inserted. `"append"` (default) places it at the
   * end; `"prepend"` places it at the top, which is what `~/.ssh/config` needs,
   * since ssh takes the first value it sees for a keyword and an existing
   * `Host *` stanza would otherwise shadow everything added after it. Once the
   * region exists it is replaced where it sits.
   */
  position: Schema.optionalKey(Position),
  /**
   * Forces this region to be written after another one.
   *
   * Alchemy builds dependency edges from one resource's props referencing
   * another's output, so pass the other region's `hash`:
   *
   * ```ts
   * const broad = yield* Dotfiles.ManagedBlock("git-personal", { ... });
   * yield* Dotfiles.ManagedBlock("git-work", { ..., after: broad.hash });
   * ```
   *
   * The value is never read — referencing it is what creates the edge.
   */
  after: Schema.optionalKey(Schema.String),
  /**
   * POSIX mode for directories created to hold this file. `~/.ssh` must be
   * `0o700` or ssh refuses to use anything inside it.
   */
  directoryMode: Schema.optionalKey(Schema.Number),
});

export type ManagedBlockProps = typeof ManagedBlockProps.Type;

/**
 * `hash` is of the region's content, so an edit inside the markers is drift.
 *
 * Declared as a schema because these are the resource's persisted attributes:
 * Alchemy writes them to its state file as JSON and hands them back on a later
 * run, so the shape crosses a serialization boundary and is worth describing
 * once rather than asserting.
 */
export const ManagedBlockState = Schema.Struct({
  path: Schema.String,
  marker: Schema.String,
  hash: Schema.String,
});

export type ManagedBlockState = typeof ManagedBlockState.Type;

export interface ManagedBlock extends Resource<
  "Machine.ManagedBlock",
  ManagedBlockProps,
  ManagedBlockState
> {}

export const ManagedBlock = Resource<ManagedBlock>("Machine.ManagedBlock");

/**
 * Raised when a file's markers for a region do not pair up — an END with no
 * BEGIN before it, or a BEGIN with no END after it.
 *
 * Splicing requires both markers, in order. Locating them independently and
 * slicing between them would, for an unpaired or inverted pair, emit a file
 * containing duplicated and nested markers, which parses as an even more
 * malformed region on the next run and compounds each time. A file whose
 * markers a person has mangled has no safe interpretation.
 */
export class ManagedBlockMalformed extends Data.TaggedError("ManagedBlockMalformed")<{
  path: string;
  marker: string;
  detail: string;
}> {
  override get message() {
    return `The machine-run region "${this.marker}" in "${this.path}" is malformed: ${this.detail}. Fix or delete the marker lines by hand — a region whose markers do not pair up will not be spliced.`;
  }
}

/**
 * Raised when {@link ManagedBlockProps.path} cannot be read at all — a
 * permissions problem, an I/O error — as distinct from "the file does not
 * exist yet", which is an ordinary state to converge from (an empty region
 * to insert into). `ManagedBlock` exists specifically for files this tool
 * does not own outright — `~/.zshrc`, `~/.gitconfig`, `~/.ssh/config` — so
 * collapsing an unreadable file into "empty" would make `apply` write just
 * the marker block over whatever hand-written content is actually there and
 * simply could not be seen.
 */
export class ManagedBlockFileUnreadable extends Data.TaggedError("ManagedBlockFileUnreadable")<{
  path: string;
  cause: PlatformError;
}> {
  override get message() {
    return `Could not read "${this.path}": ${this.cause.reason._tag}.`;
  }
}

const DEFAULT_COMMENT = "#";

export const beginMarker = (marker: string, comment = DEFAULT_COMMENT) =>
  `${comment} machine-run:${marker} BEGIN`;
export const endMarker = (marker: string, comment = DEFAULT_COMMENT) =>
  `${comment} machine-run:${marker} END`;

export interface RenderOptions {
  readonly commentPrefix?: string | undefined;
  readonly position?: Position | undefined;
}

/**
 * Region content is compared, and stored in {@link ManagedBlockState}'s hash,
 * in its canonical LF form with trailing blank lines dropped — never in the
 * file's own line-ending convention.
 *
 * This has to be convention-independent for the same reason a raw
 * `content.replace(/\n+$/, "")` was wrong: on a CRLF file, the region
 * extracted by {@link readBlock} carries `\r\n` between its lines, while
 * `desired`'s `props.content` is an ordinary LF TypeScript string literal —
 * comparing those byte-for-byte would report drift forever even when nobody
 * touched a single character, purely because of which OS's editor last saved
 * the surrounding file. Canonicalizing both sides here, once, is what makes
 * "does the content differ" and "which bytes does this file happen to use"
 * two separate questions; `renderFile` is the one place that answers the
 * second one, by re-rendering this canonical form in `existing`'s own
 * convention before anything is written to disk.
 */
const normalize = (content: string): string => {
  const lines = splitLines(content);
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(0, end).join("\n");
};

/** How many times `needle` appears in `haystack`, counting non-overlapping hits. */
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/**
 * The current content of a region, or `undefined` when the file has no such
 * region.
 *
 * Reading the region back is what makes drift detectable: a hash recorded at
 * write time cannot distinguish "someone edited this region" from "nothing
 * changed", because both leave it equal to what was last written.
 */
export const readBlock = (
  existing: string,
  marker: string,
  options: RenderOptions = {},
): string | undefined => {
  const begin = beginMarker(marker, options.commentPrefix);
  const end = endMarker(marker, options.commentPrefix);
  const beginIndex = existing.indexOf(begin);
  if (beginIndex === -1) return undefined;
  const endIndex = existing.indexOf(end, beginIndex + begin.length);
  if (endIndex === -1) return undefined;
  // The slice starts right after BEGIN's own text, so its first character(s)
  // are still the terminator that ends the BEGIN line — `\r\n` on a CRLF
  // file, `\n` on an LF one. `\r?\n` (the same idiom `Windows/Icacls.ts`
  // already uses for line-ending-agnostic parsing) strips exactly that one
  // terminator regardless of which it is; a bare `/^\n/` left the `\r` behind
  // on a CRLF file, becoming a leading blank line `normalize` never asked to
  // trim.
  return normalize(existing.slice(beginIndex + begin.length, endIndex).replace(/^\r?\n/, ""));
};

/**
 * Replaces, or inserts, the marked region within `existing`, leaving the rest
 * of the file untouched.
 *
 * Returns a {@link Result} rather than throwing, so a malformed file is an
 * ordinary value the caller has to handle, and this stays a total function
 * testable without a runtime.
 */
export const renderFile = (
  existing: string,
  marker: string,
  content: string,
  options: RenderOptions = {},
): Result.Result<string, { detail: string }> => {
  const comment = options.commentPrefix ?? DEFAULT_COMMENT;
  const begin = beginMarker(marker, comment);
  const end = endMarker(marker, comment);
  const body = normalize(content);

  // Content carrying either marker would make the region's own boundaries
  // ambiguous the moment it is written: the next read finds the marker inside
  // the content and treats it as the edge, so the region truncates and the
  // real END is left orphaned in the file. There is no escaping scheme worth
  // having here — these files are shell configs and ssh configs, whose bytes
  // must survive verbatim — so this refuses instead, and the caller changes
  // either the content or the marker.
  if (body.includes(begin) || body.includes(end)) {
    return Result.fail({
      detail: `the content contains this region's own marker ("${begin}" or "${end}"), which would make its boundaries ambiguous`,
    });
  }

  // The file's own convention, preserved rather than overwritten — see
  // `LineEndings.ts`'s doc comment for the policy and why LF is the default
  // for `existing === ""` (a brand-new file has nothing to preserve).
  // `body` is `normalize`'s canonical LF form, so re-splitting it on a plain
  // `"\n"` (rather than `splitLines`, which also handles `\r\n`) is safe —
  // and `Array.prototype.join`, not `joinLines`, is used deliberately here:
  // `joinLines` always terminates its last line too, which would double up
  // the separator this template already places before `end`.
  const eol = LineEndingChars[detectLineEnding(existing)];
  const bodyForFile = splitLines(body).join(eol);
  const region = `${begin}${eol}${bodyForFile}${eol}${end}`;

  const beginIndex = existing.indexOf(begin);
  // END is searched for after BEGIN so an inverted pair is detected rather
  // than spliced into nonsense.
  const endIndex =
    beginIndex === -1 ? existing.indexOf(end) : existing.indexOf(end, beginIndex + begin.length);

  // A file that already carries a duplicated marker cannot be spliced
  // unambiguously, whoever put it there — an older write that predates the
  // guard above, a hand edit, or two resources sharing one marker. Splicing
  // the first pair would silently discard whatever sits between the others.
  if (occurrences(existing, begin) > 1 || occurrences(existing, end) > 1) {
    return Result.fail({
      detail:
        "the file contains more than one of this region's markers, so its boundaries are ambiguous",
    });
  }

  if (beginIndex === -1 && endIndex === -1) {
    if (options.position === "prepend") {
      return Result.succeed(
        Boolean.match(existing.length === 0, {
          onTrue: () => `${region}${eol}`,
          onFalse: () => `${region}${eol}${existing}`,
        }),
      );
    }
    // `existing.endsWith("\n")` still correctly answers "does the file
    // already end in a terminator" for a CRLF file too, since `\r\n` itself
    // ends with `\n` — only the separator actually inserted needs to change
    // with the convention, not this check.
    const separator = Boolean.match(existing.length > 0 && !existing.endsWith("\n"), {
      onTrue: () => eol,
      onFalse: () => "",
    });
    return Result.succeed(`${existing}${separator}${region}${eol}`);
  }

  if (beginIndex === -1) {
    return Result.fail({
      detail: "an END marker is present with no matching BEGIN before it",
    });
  }
  if (endIndex === -1) {
    return Result.fail({
      detail: "a BEGIN marker is present with no matching END after it",
    });
  }

  return Result.succeed(
    `${existing.slice(0, beginIndex)}${region}${existing.slice(endIndex + end.length)}`,
  );
};

/**
 * The inverse of {@link renderFile}: removes the marked region, plus one
 * adjacent line terminator so the gap it occupied doesn't become a blank
 * line, leaving the rest of `existing` untouched. A no-op — not a
 * failure — when the region isn't there to begin with.
 *
 * Same ambiguity guards as `renderFile`: a duplicated or unpaired marker
 * cannot be spliced out unambiguously any more than one can be spliced in.
 */
export const removeBlock = (
  existing: string,
  marker: string,
  options: RenderOptions = {},
): Result.Result<string, { detail: string }> => {
  const comment = options.commentPrefix ?? DEFAULT_COMMENT;
  const begin = beginMarker(marker, comment);
  const end = endMarker(marker, comment);

  if (occurrences(existing, begin) > 1 || occurrences(existing, end) > 1) {
    return Result.fail({
      detail:
        "the file contains more than one of this region's markers, so its boundaries are ambiguous",
    });
  }

  const beginIndex = existing.indexOf(begin);
  const endIndex =
    beginIndex === -1 ? existing.indexOf(end) : existing.indexOf(end, beginIndex + begin.length);

  if (beginIndex === -1 && endIndex === -1) return Result.succeed(existing);
  if (beginIndex === -1) {
    return Result.fail({
      detail: "an END marker is present with no matching BEGIN before it",
    });
  }
  if (endIndex === -1) {
    return Result.fail({
      detail: "a BEGIN marker is present with no matching END after it",
    });
  }

  const before = existing.slice(0, beginIndex);
  const after = existing.slice(endIndex + end.length).replace(/^\r?\n/, "");
  return Result.succeed(`${before}${after}`);
};

export const makeManagedBlockReconciler: Effect.Effect<
  Reconciler<
    ManagedBlockProps,
    ManagedBlockState,
    PlatformError | ManagedBlockMalformed | ManagedBlockFileUnreadable
  >,
  never,
  FileSystem.FileSystem | Path.Path | MachinePaths | Crypto.Crypto
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* MachinePaths;
  const sha256 = yield* makeSha256;

  // A file that does not exist yet holds no managed region, which is the same
  // answer as a file that exists and holds none — so `none` collapses to `""`
  // here deliberately. The distinction the helper preserves matters to callers
  // that can act on "the file is missing"; this one cannot.
  const readFileOrEmpty = (target: string) =>
    readIfPresent(
      fs,
      target,
      (cause) => new ManagedBlockFileUnreadable({ path: target, cause }),
    ).pipe(Effect.map(Option.getOrElse(() => "")));

  return {
    address: (props) => paths.expand(props.path),
    snapshotBeforeApply: true,
    // the resource that exists *for* files with other owners.
    refuseUnowned: true,

    observe: (props) =>
      Effect.gen(function* () {
        const target = paths.expand(props.path);
        const current = readBlock(yield* readFileOrEmpty(target), props.marker, props);
        if (current === undefined) return Option.none();
        return Option.some({ path: target, marker: props.marker, hash: yield* sha256(current) });
      }),

    desired: (props) =>
      Effect.gen(function* () {
        return {
          path: paths.expand(props.path),
          marker: props.marker,
          hash: yield* sha256(normalize(props.content)),
        };
      }),

    // Path and marker address the region rather than describe it, so both take
    // part: moving a region to another file, or renaming its marker, leaves the
    // content identical but still has to be applied.
    matches: (observed, desired) =>
      observed.path === desired.path &&
      observed.marker === desired.marker &&
      observed.hash === desired.hash,

    drift: (observed, desired): Drift => {
      const fields: DriftField[] = [];
      if (observed.path !== desired.path) {
        fields.push({ field: "path", observed: observed.path, desired: desired.path });
      }
      if (observed.marker !== desired.marker) {
        fields.push({ field: "marker", observed: observed.marker, desired: desired.marker });
      }
      if (observed.hash !== desired.hash) {
        fields.push({ field: "content", observed: observed.hash, desired: desired.hash });
      }
      return fields;
    },

    apply: ({ props, desired }) =>
      Effect.gen(function* () {
        const target = desired.path;
        yield* fs.makeDirectory(path.dirname(target), {
          recursive: true,
          ...(props.directoryMode !== undefined ? { mode: props.directoryMode } : {}),
        });

        const existing = yield* readFileOrEmpty(target);
        const rendered = renderFile(existing, props.marker, props.content, props);
        if (Result.isFailure(rendered)) {
          return yield* Effect.fail(
            new ManagedBlockMalformed({
              path: target,
              marker: props.marker,
              detail: rendered.failure.detail,
            }),
          );
        }

        yield* fs.writeFileString(target, rendered.success);
        return desired;
      }),

    // This resource owns only its own region, never the whole file — so
    // "undo" is splicing that region back out, not touching anything else
    // a person (or another `ManagedBlock`) put there.
    unapply: ({ props, observed }) =>
      Effect.gen(function* () {
        const target = observed.path;
        const existing = yield* readFileOrEmpty(target);
        const removed = removeBlock(existing, props.marker, props);
        if (Result.isFailure(removed)) {
          return yield* Effect.fail(
            new ManagedBlockMalformed({
              path: target,
              marker: props.marker,
              detail: removed.failure.detail,
            }),
          );
        }
        yield* fs.writeFileString(target, removed.success);
      }),
  };
});

export const ManagedBlockProvider = () => toProvider(ManagedBlock, makeManagedBlockReconciler);
