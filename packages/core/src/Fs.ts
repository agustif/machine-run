import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { isNotFound } from "./Paths.ts";

/**
 * Reads a file, distinguishing "genuinely absent" from "could not be read"
 * — the discipline `Ssh.Key` and `Ssh.KnownHost` already hand-derive
 * correctly, and `ManagedBlock`, `LineInFile`, `Git.Repo` and `Codex` each
 * got wrong in a different place by folding every read failure into "empty".
 * A locked file, a permission change, a momentarily-busy device then reads as
 * "nothing here", and a reconciler that owns only part of a file overwrites
 * the part it does not.
 *
 * There is no default for `onUnreadable`: a genuine not-found becomes
 * `Option.none()`, and every other `PlatformError` is handed to the caller's
 * mapper rather than absorbed. A caller cannot get the old
 * swallow-everything behaviour by omission — they have to write a mapper
 * that deliberately discards the distinction, which is a much louder thing
 * to have done wrong than leaving an argument out.
 *
 * Returns `Option.Option<string>` rather than `string | undefined` so an
 * absent file (`Option.none()`) stays distinguishable from a present-but-
 * empty one (`Option.some("")`) — collapsing those two was itself part of
 * the bug this replaces.
 */
export const readIfPresent = <E>(
  fs: FileSystem.FileSystem,
  target: string,
  onUnreadable: (cause: PlatformError) => E,
): Effect.Effect<Option.Option<string>, E> =>
  fs.readFileString(target).pipe(
    Effect.map(Option.some),
    Effect.catchTag("PlatformError", (cause) => {
      if (isNotFound(cause)) return Effect.succeed(Option.none<string>());
      return Effect.fail(onUnreadable(cause));
    }),
  );

/**
 * `stat`'s counterpart to {@link readIfPresent}: presence and metadata
 * without opening the file, for the callers that only need to know a path
 * exists (or its mode) and must never read its content — `Ssh.Key`'s private
 * half being the reason this distinction matters at all.
 *
 * Same guard: `onUnreadable` is required, so "absent" can only ever mean a
 * genuine not-found.
 */
export const statIfPresent = <E>(
  fs: FileSystem.FileSystem,
  target: string,
  onUnreadable: (cause: PlatformError) => E,
): Effect.Effect<Option.Option<FileSystem.File.Info>, E> =>
  fs.stat(target).pipe(
    Effect.map(Option.some),
    Effect.catchTag("PlatformError", (cause) => {
      if (isNotFound(cause)) return Effect.succeed(Option.none<FileSystem.File.Info>());
      return Effect.fail(onUnreadable(cause));
    }),
  );

/**
 * The POSIX permission bits out of a `stat` result, with the file-type bits
 * `stat` also carries in `mode` masked off.
 *
 * `info.mode` is already a plain `number` in this pinned Effect version;
 * `Number(...)` is kept because that is the exact expression the seven call
 * sites this replaces all wrote, and because `FileSystem.File.Info` is
 * declared by a dependency this package does not control the future shape
 * of.
 */
export const posixMode = (info: FileSystem.File.Info): number => Number(info.mode) & 0o777;

/** Mode for a file that may carry a credential: owner read/write only. */
export const CREDENTIAL_FILE_MODE = 0o600;

/** Mode for a directory created to hold one: owner-only, so the name of a
 * secret file is not enumerable by other users even when the file itself is
 * unreadable. */
export const CREDENTIAL_DIRECTORY_MODE = 0o700;

/**
 * Writes a file that may carry a credential, at a mode that never exposes it.
 *
 * Both halves are load-bearing, and each was measured rather than assumed:
 *
 * - `mode` is passed to `writeFileString` so the file is *created* restricted.
 *   Writing first and chmod'ing after leaves the content readable at the
 *   process umask (0644 on a default machine) for the window in between, in
 *   the very directory an attacker would look.
 * - `chmod` still follows, because the OS applies `mode` *only on creation*.
 *   Measured directly: writing to an existing 0644 file with `{ mode: 0o600 }`
 *   leaves it 0644. Without the chmod, a config file some other tool created
 *   world-readable stays world-readable forever, and a reconciler that
 *   observes mode never converges.
 *
 * `SecretFile` derived this pair correctly on its own; this is that same
 * discipline made reusable, after the AI backends were found writing MCP
 * server credentials at 0644 without either half.
 */
export const writeCredentialFileString = (
  fs: FileSystem.FileSystem,
  target: string,
  content: string,
  mode: number = CREDENTIAL_FILE_MODE,
): Effect.Effect<void, PlatformError> =>
  Effect.gen(function* () {
    yield* fs.writeFileString(target, content, { mode });
    yield* fs.chmod(target, mode);
  });

/**
 * Creates the parent directory of `target`, recursively, before a caller
 * writes to `target` itself. `mode` is the mode for any directories created
 * in the process — omitted, it takes the platform default — and is a plain
 * pass-through to `FileSystem.makeDirectory`'s own optional `mode`, so there
 * is no conditional spread to get wrong here or at any of the six call sites
 * this replaces.
 */
export const ensureParentDir = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
  mode?: number,
): Effect.Effect<void, PlatformError> =>
  fs.makeDirectory(path.dirname(target), { recursive: true, mode });
