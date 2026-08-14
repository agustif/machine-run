import { isNotFound } from "@machine-run/core";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";

/**
 * Reads a file's content, treating only a genuine not-found as "absent"
 * (`""`) — everything else, a permission problem, an I/O error, anything that
 * is not "there is nothing here yet", raises through `onUnreadable` instead.
 *
 * This is the `stat` + `isNotFound` discipline `ssh/src/Key.ts` and
 * `ssh/src/KnownHost.ts` already apply to presence checks, extended to a read.
 * It exists specifically so that discipline is the *short* thing to write for
 * a read: `fs.readFileString(target).pipe(Effect.orElseSucceed(() => ""))`
 * was shorter than doing this by hand, and that is exactly why `ManagedBlock`,
 * `LineInFile` and `File` each wrote it and each lost a permission error or an
 * I/O error as "the file is empty" (see `MUST_CLEANUP.md` 0.2–0.5). Each
 * caller supplies its own error constructor because each resource needs its
 * own tagged class for `catchTag` to discriminate on downstream.
 */
export const readIfPresent = <E>(
  fs: FileSystem.FileSystem,
  target: string,
  onUnreadable: (cause: PlatformError) => E,
): Effect.Effect<string, E> =>
  fs.readFileString(target).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      isNotFound(cause) ? Effect.succeed("") : Effect.fail(onUnreadable(cause)),
    ),
  );
