import { CREDENTIAL_FILE_MODE, isNotFound, MachinePaths, Platform, Windows } from "@machine-run/core";
import { type Drift, type DriftField, type Reconciler, toProvider } from "@machine-run/engine";
import { Resource } from "alchemy/Resource";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Boolean from "effect/Boolean";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { type PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as UndefinedOr from "effect/UndefinedOr";
import { HttpClientError } from "effect/unstable/http/HttpClientError";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

/**
 * Raised when the downloaded bytes' SHA-256 does not match
 * {@link DownloadProps.checksum}.
 *
 * Carries both digests so the operator can tell a stale `checksum` (the
 * upstream file legitimately changed) from real tampering or corruption in
 * transit — a message with only "mismatch" gives them nothing to act on.
 * Nothing is written to `path` when this is raised; see {@link Download}'s
 * doc comment for why that ordering is load-bearing.
 */
export class DownloadChecksumMismatch extends Data.TaggedError("DownloadChecksumMismatch")<{
  url: string;
  path: string;
  expected: string;
  actual: string;
}> {
  override get message() {
    return `Downloaded "${this.url}" but its SHA-256 (${this.actual}) does not match the declared checksum (${this.expected}). Nothing was written to "${this.path}" — confirm the upstream file is what you expect before updating "checksum", rather than copying "actual" in blind.`;
  }
}

/**
 * Raised when something occupies {@link DownloadProps.path} that is not a
 * plain file — most likely a directory. Hashing it would either fail
 * outright or (worse) silently hash the wrong thing, and overwriting it on
 * `apply` would destroy whatever is really there.
 */
export class DownloadPathIsNotFile extends Data.TaggedError("DownloadPathIsNotFile")<{
  path: string;
}> {
  override get message() {
    return `"${this.path}" exists but is not a plain file. Machine.Download will not overwrite it — remove it by hand if a downloaded file belongs there.`;
  }
}

/**
 * Raised when {@link DownloadProps.path} cannot be inspected at all, as
 * distinct from "nothing is there yet" (see `Symlink`'s
 * `SymlinkPathUnreadable`, the same distinction for the same reason).
 */
export class DownloadPathUnreadable extends Data.TaggedError("DownloadPathUnreadable")<{
  path: string;
  cause: PlatformError;
}> {
  override get message() {
    return `Could not inspect "${this.path}" while reconciling a download: ${this.cause.reason._tag}.`;
  }
}

/**
 * A file fetched from `url` and placed at `path`, gated on an explicit
 * checksum.
 *
 * `checksum` is **required**, not optional: a download this tool cannot
 * verify is not something it can reconcile — there is no live signal to
 * compare against on a later run other than "a file happens to be there",
 * which would silently accept a corrupted or replaced upstream artifact
 * forever. This is what makes it safe to use for fonts and binaries, where a
 * silently-wrong file is worse than a failed apply.
 */
/** 256 MiB: comfortably above a font or CLI binary, far below a disk image. */
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

export const DownloadProps = Schema.Struct({
  /** URL to fetch. */
  url: Schema.String,
  /** Path the downloaded file should occupy. `~` is expanded. */
  path: Schema.String,
  /**
   * Ceiling on how many bytes this will hold in memory to hash.
   *
   * Applies to both the fetched response and the file already on disk, since
   * observing drift re-hashes what is there. @default 256 MiB
   */
  maxBytes: Schema.optionalKey(Schema.Number),
  /** Expected hex-encoded SHA-256 of the downloaded bytes. */
  checksum: Schema.String,
  /** POSIX file mode, e.g. `0o644`. Left unconstrained when unset. */
  mode: Schema.optionalKey(Schema.Number),
});

export type DownloadProps = typeof DownloadProps.Type;

/**
 * Raised when an artifact is larger than {@link DownloadProps.maxBytes}.
 *
 * `Crypto.digest` is one-shot — it takes a whole `Uint8Array` and Effect
 * exposes no incremental hashing — so verifying a download means holding all
 * of it in memory at once. That is fine for the things this resource exists
 * for (a font, a CLI binary, a small archive) and ruinous for a disk image.
 *
 * An explicit ceiling turns "the reconciler exhausted memory and took the
 * machine with it" into a message naming the file and the limit. It is a prop
 * rather than a constant because the right ceiling depends on what is being
 * fetched, and raising it is a deliberate choice about memory this process is
 * allowed to use.
 */
export class DownloadTooLarge extends Data.TaggedError("DownloadTooLarge")<{
  path: string;
  bytes: number;
  limit: number;
}> {
  override get message() {
    return `"${this.path}" is ${this.bytes} bytes, over the ${this.limit}-byte limit this resource will hold in memory to verify. Raise \`maxBytes\` if that is genuinely intended — hashing requires the whole artifact at once.`;
  }
}

/**
 * `hash` is of the file's actual bytes, so a file replaced or corrupted after
 * writing stops matching and is re-fetched. `mode` is only ever absent from
 * *desired* state (an unconstrained recipe) — observed state always reports
 * the live bits.
 */
export const DownloadState = Schema.Struct({
  path: Schema.String,
  hash: Schema.String,
  mode: Schema.optionalKey(Schema.Number),
  /** `icacls <path>`'s listing, on Windows only — see `Machine.Directory`. */
  acl: Schema.optionalKey(Schema.String),
});

export type DownloadState = typeof DownloadState.Type;

export interface Download extends Resource<"Machine.Download", DownloadProps, DownloadState> {}

export const Download = Resource<Download>("Machine.Download");

/**
 * Whether observed permissions satisfy the desired mode — mode bits on POSIX,
 * the live ACL on Windows, where there is no mode to compare. An unreadable ACL
 * is never satisfied: "cannot confirm" converges by re-applying. See
 * `Machine.Directory` for the full reasoning.
 */
const modeSatisfied = (
  platform: typeof Platform.Service,
  observed: { readonly path: string; readonly mode?: number; readonly acl?: string },
  desiredMode: number | undefined,
): boolean => {
  if (desiredMode === undefined) return true;
  if (!platform.isWindows) return observed.mode === desiredMode;
  return Windows.aclSatisfiesMode(
    UndefinedOr.match(observed.acl, {
      onUndefined: () => Option.none<string>(),
      onDefined: (acl) => Option.some(acl),
    }),
    observed.path,
    desiredMode,
    "file",
  );
};

export const makeDownloadReconciler: Effect.Effect<
  Reconciler<
    DownloadProps,
    DownloadState,
    | DownloadTooLarge
    | PlatformError
    | HttpClientError
    | DownloadChecksumMismatch
    | DownloadPathIsNotFile
    | DownloadPathUnreadable
  >,
  never,
  | FileSystem.FileSystem
  | Path.Path
  | MachinePaths
  | Crypto.Crypto
  | HttpClient.HttpClient
  | Platform
> = Effect.gen(function* () {
  const platform = yield* Platform;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* MachinePaths;
  const crypto = yield* Crypto.Crypto;
  // Resolved once, like `fs`/`path`/`paths`/`crypto` above, so every
  // reconciler method's own `Effect` type is `R = never` — the requirement
  // is on *building* the reconciler, not on each call.
  const client = yield* HttpClient.HttpClient;

  /**
   * Hex SHA-256 of raw bytes.
   *
   * `@machine-run/core`'s `makeSha256` takes a `string`, which is the wrong
   * shape here twice over: a downloaded font or binary is not valid UTF-8, so
   * decoding it to a string and re-encoding would risk altering the very
   * bytes being verified, and holding a second string copy of a large
   * download purely to hash it is wasted work. `Crypto.Crypto.digest` takes
   * the `Uint8Array` directly.
   */
  const hashBytes = (bytes: Uint8Array) =>
    crypto.digest("SHA-256", bytes).pipe(Effect.map(Encoding.encodeHex));

  return {
    address: (props) => paths.expand(props.path),

    observe: (props, ctx) =>
      Effect.gen(function* () {
        const target = paths.expand(props.path);
        const info = yield* fs
          .stat(target)
          .pipe(
            Effect.catchTag("PlatformError", (cause) =>
              isNotFound(cause)
                ? Effect.succeed(undefined)
                : Effect.fail(new DownloadPathUnreadable({ path: target, cause })),
            ),
          );
        if (info === undefined) return Option.none();
        if (info.type !== "File") {
          return yield* Effect.fail(new DownloadPathIsNotFile({ path: target }));
        }
        // Checked from `stat` before reading: `observe` runs during planning,
        // and a plan must not be able to exhaust memory just by previewing a
        // recipe that mentions a large artifact.
        const limit = props.maxBytes ?? DEFAULT_MAX_BYTES;
        const size = Number(info.size);
        if (size > limit) {
          return yield* Effect.fail(new DownloadTooLarge({ path: target, bytes: size, limit }));
        }
        const bytes = yield* fs.readFile(target);
        const acl = yield* Boolean.match(platform.isWindows, {
          onFalse: () => Effect.succeed(Option.none<string>()),
          onTrue: () => Windows.readAcl(ctx.exec, target),
        });
        return Option.some({
          path: target,
          hash: yield* hashBytes(bytes),
          mode: Number(info.mode) & 0o777,
          ...Option.match(acl, { onNone: () => ({}), onSome: (value) => ({ acl: value }) }),
        });
      }),

    // No network call here: the whole point of a required `checksum` is that
    // it *is* the desired hash, so "what should be true" is knowable from
    // props alone. `diff` (and any other planning-time caller of `desired`)
    // never has to fetch anything just to decide whether a re-fetch is
    // needed.
    desired: (props) =>
      Effect.succeed({
        path: paths.expand(props.path),
        hash: props.checksum,
        ...(props.mode !== undefined ? { mode: props.mode } : {}),
      }),

    matches: (observed, desired) =>
      observed.path === desired.path &&
      observed.hash === desired.hash &&
      modeSatisfied(platform, observed, desired.mode),

    drift: (observed, desired): Drift => {
      const fields: DriftField[] = [];
      if (observed.path !== desired.path) {
        fields.push({ field: "path", observed: observed.path, desired: desired.path });
      }
      if (observed.hash !== desired.hash) {
        // Unordered, and a full digest is unreadable in plan output — a
        // short prefix is enough to show "this changed".
        fields.push({
          field: "content",
          observed: observed.hash.slice(0, 12),
          desired: desired.hash.slice(0, 12),
        });
      }
      if (desired.mode !== undefined && observed.mode !== desired.mode) {
        const desiredMode = desired.mode;
        const modeField: DriftField =
          observed.mode === undefined
            ? { field: "mode", observed: "unset", desired: desiredMode.toString(8) }
            : {
                field: "mode",
                observed: observed.mode.toString(8),
                desired: desiredMode.toString(8),
                direction: observed.mode < desiredMode ? "behind" : "ahead",
              };
        fields.push(modeField);
      }
      return fields;
    },

    apply: ({ props, desired }, ctx) =>
      Effect.gen(function* () {
        const target = desired.path;
        const dir = path.dirname(target);

        // Fetched and hashed entirely in memory before anything touches the
        // filesystem: a checksum mismatch must leave `target` exactly as it
        // was, not briefly replaced by unverified content. `HttpClient` is
        // Effect's own request/response service (`effect/unstable/http`,
        // shipped inside `effect` itself — no `@effect/platform` dependency
        // needed) rather than `ctx.exec` + `curl`: it is what Alchemy's own
        // `Stack` already provides to every provider (see
        // `alchemy/src/Stack.ts`'s `StackServices`, backed by
        // `FetchHttpClient.layer`), and it gives a typed `HttpClientError`
        // instead of parsing `curl`'s exit code and stderr.
        const response = yield* client
          .get(props.url)
          .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
        const bytes = new Uint8Array(yield* response.arrayBuffer);
        // Enforced on the real byte count rather than `Content-Length`, which
        // is absent on a chunked response and is in any case a claim by the
        // server rather than a fact.
        const limit = props.maxBytes ?? DEFAULT_MAX_BYTES;
        if (bytes.byteLength > limit) {
          return yield* Effect.fail(
            new DownloadTooLarge({ path: target, bytes: bytes.byteLength, limit }),
          );
        }
        const actual = yield* hashBytes(bytes);
        if (actual !== props.checksum) {
          return yield* Effect.fail(
            new DownloadChecksumMismatch({
              url: props.url,
              path: target,
              expected: props.checksum,
              actual,
            }),
          );
        }

        yield* fs.makeDirectory(dir, { recursive: true });

        // Written to a fresh temp file in the *same* directory (so the
        // rename below is a same-filesystem, atomic replace rather than a
        // cross-filesystem copy that could itself be interrupted), with the
        // desired mode set before it ever appears at `target`.
        //
        // The empty temp file is restricted *before* the bytes go into it.
        // `makeTempFile` creates at the process umask — measured at 0644 on a
        // default machine, not the 0600 its name suggests — and the temp file
        // lives in the target's own directory, so restricting only afterwards
        // leaves the downloaded content world-readable for the duration of
        // the write, exactly where a reader would look for it. An empty 0644
        // file leaks nothing; a populated one can.
        //
        // It is restricted to 0600 rather than straight to `props.mode`
        // because the final mode need not be writable by anyone: chmod'ing to
        // a read-only mode like 0444 first makes the write that follows fail
        // with EACCES, for the owner too. 0600 is writable by us and readable
        // by no one else, which is what this window needs; `props.mode` is
        // applied once the content is in place.
        // Both chmods are conditional on the same `props.mode`, so a download
        // that asked for no particular mode still lands at the platform
        // default exactly as before — the protection is scoped to the case
        // that needs it rather than quietly tightening every download.
        const tempPath = yield* fs.makeTempFile({ directory: dir });
        if (props.mode !== undefined) {
          yield* fs.chmod(tempPath, CREDENTIAL_FILE_MODE);
          yield* fs.writeFile(tempPath, bytes);
          yield* Boolean.match(platform.isWindows, {
            onFalse: () => fs.chmod(tempPath, props.mode ?? 0),
            onTrue: () =>
              Windows.applyMode(ctx.exec, tempPath, props.mode ?? 0, "file").pipe(
                Effect.orElseSucceed(() => undefined),
              ),
          });
        } else {
          yield* fs.writeFile(tempPath, bytes);
        }
        yield* fs.rename(tempPath, target);

        const info = yield* fs.stat(target);
        return { path: target, hash: actual, mode: Number(info.mode) & 0o777 };
      }),

    // This resource always writes the whole file — never backed up, since
    // there is no prior version worth restoring (a verified download either
    // matches its checksum or is rejected outright). Removing it is the
    // honest undo of "a verified artifact is at this path".
    unapply: ({ observed }) => fs.remove(observed.path),
  };
});

export const DownloadProvider = () => toProvider(Download, makeDownloadReconciler);
