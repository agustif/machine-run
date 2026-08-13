import { backupIfExists } from "@machine-run/core";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

export class SymlinkSourceMissing extends Data.TaggedError("SymlinkSourceMissing")<{
  source: string;
}> {
  override get message() {
    return `Symlink source "${this.source}" does not exist. machine-run never fabricates content for a symlink target — copy the reviewed file or directory into the repo first, then point this resource at it.`;
  }
}

/**
 * A whole file or directory machine-run makes available at `path` by
 * symlinking it to `source` (typically a reviewed, checked-in location
 * inside this repo). Use this over {@link File}/{@link ManagedBlock} for
 * larger assets that are naturally a directory (an editor's `skills/`
 * folder) rather than something to template as a string.
 *
 * Deliberately does NOT auto-adopt real content: if `source` doesn't exist,
 * reconcile fails with a clear error instead of creating an empty
 * placeholder. Bringing a real config under management is a deliberate,
 * reviewed step (copy it into the repo yourself) — never an automatic one,
 * since these directories can also contain credentials that must never be
 * copied into a git repo unreviewed.
 */
export interface SymlinkProps {
  /** Real, absolute location that should become a symlink, e.g. `~/.claude/skills`. */
  path: string;
  /** Absolute path to the source of truth this should point at. */
  source: string;
}

export interface Symlink
  extends Resource<"Machine.Symlink", SymlinkProps, { path: string; source: string }> {}

export const Symlink = Resource<Symlink>("Machine.Symlink");

export const SymlinkProvider = () =>
  Provider.effect(
    Symlink,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const currentTarget = (linkPath: string) => fs.readLink(linkPath).pipe(Effect.option);

      return Symlink.Provider.of({
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ news }) {
          if (!isResolved(news)) return undefined;
          const current = yield* currentTarget(news.path);
          if (Option.isNone(current) || current.value !== news.source) {
            return { action: "update" as const };
          }
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const sourceExists = yield* fs.exists(news.source);
          if (!sourceExists) {
            return yield* Effect.fail(new SymlinkSourceMissing({ source: news.source }));
          }

          const dir = path.dirname(news.path);
          yield* fs.makeDirectory(dir, { recursive: true });

          const current = yield* currentTarget(news.path);
          if (Option.isSome(current) && current.value === news.source) {
            return { path: news.path, source: news.source };
          }

          const exists = yield* fs.exists(news.path);
          if (exists) {
            if (!output) {
              yield* backupIfExists(news.path, path.join(dir, ".machine-run-backups"));
            }
            yield* fs.remove(news.path, { recursive: true });
          }

          yield* fs.symlink(news.source, news.path);
          return { path: news.path, source: news.source };
        }),
        // Never removes the real path or the symlink on destroy — same
        // rationale as File.ts/ManagedBlock.ts.
        delete: () => Effect.void,
      });
    }),
  );
