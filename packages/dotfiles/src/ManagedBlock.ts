import { MachinePaths, makeSha256 } from "@machine-run/core";
import { type Reconciler, toProvider } from "@machine-run/engine";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
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

const DEFAULT_COMMENT = "#";

export const beginMarker = (marker: string, comment = DEFAULT_COMMENT) =>
  `${comment} machine-run:${marker} BEGIN`;
export const endMarker = (marker: string, comment = DEFAULT_COMMENT) =>
  `${comment} machine-run:${marker} END`;

export interface RenderOptions {
  readonly commentPrefix?: string | undefined;
  readonly position?: Position | undefined;
}

/** Region content is compared and stored without trailing blank lines. */
const normalize = (content: string) => content.replace(/\n+$/, "");

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
  return normalize(existing.slice(beginIndex + begin.length, endIndex).replace(/^\n/, ""));
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
  const region = `${begin}\n${normalize(content)}\n${end}`;

  const beginIndex = existing.indexOf(begin);
  // END is searched for after BEGIN so an inverted pair is detected rather
  // than spliced into nonsense.
  const endIndex =
    beginIndex === -1 ? existing.indexOf(end) : existing.indexOf(end, beginIndex + begin.length);

  if (beginIndex === -1 && endIndex === -1) {
    if (options.position === "prepend") {
      return Result.succeed(existing.length === 0 ? `${region}\n` : `${region}\n${existing}`);
    }
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    return Result.succeed(`${existing}${separator}${region}\n`);
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

export const makeManagedBlockReconciler: Effect.Effect<
  Reconciler<ManagedBlockProps, ManagedBlockState, PlatformError | ManagedBlockMalformed>,
  never,
  FileSystem.FileSystem | Path.Path | MachinePaths | Crypto.Crypto
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* MachinePaths;
  const sha256 = yield* makeSha256;

  const readFileOrEmpty = (target: string) =>
    fs.readFileString(target).pipe(Effect.orElseSucceed(() => ""));

  return {
    address: (props) => paths.expand(props.path),
    snapshotBeforeApply: true,

    observe: (props) =>
      Effect.gen(function* () {
        const target = paths.expand(props.path);
        const current = readBlock(yield* readFileOrEmpty(target), props.marker, props);
        if (current === undefined) return undefined;
        return { path: target, marker: props.marker, hash: yield* sha256(current) };
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
  };
});

export const ManagedBlockProvider = () => toProvider(ManagedBlock, makeManagedBlockReconciler);
