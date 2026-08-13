import { backupIfExists, sha256 } from "@machine-run/core";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * A file machine-run fully owns — the whole file's content is generated and
 * overwritten on every apply. Use this for files nothing else hand-edits
 * (generated persona configs, a generated Brewfile, mise's config.toml). For
 * a file with substantial pre-existing hand-written content that must be
 * preserved (`~/.zshrc`, `~/.gitconfig`, `~/.ssh/config`), use
 * {@link ManagedBlock} instead.
 */
export interface FileProps {
  /** Absolute path to the file this resource owns. */
  path: string;
  /** Full desired content of the file. */
  content: string;
  /** Optional POSIX file mode, e.g. `0o600`. */
  mode?: number;
}

export interface File
  extends Resource<"Machine.File", FileProps, { path: string; hash: string }> {}

export const File = Resource<File>("Machine.File");

export const FileProvider = () =>
  Provider.effect(
    File,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      return File.Provider.of({
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
          const desiredHash = yield* sha256(news.content);
          if (!output || output.hash !== desiredHash) {
            return { action: "update" as const };
          }
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const dir = path.dirname(news.path);
          yield* fs.makeDirectory(dir, { recursive: true });
          // Only on this resource's first-ever reconcile (no prior output) —
          // snapshots whatever real file already sat at `news.path` before
          // machine-run starts overwriting it on every apply.
          if (!output) {
            yield* backupIfExists(news.path, path.join(dir, ".machine-run-backups"));
          }
          yield* fs.writeFileString(news.path, news.content);
          if (news.mode !== undefined) {
            yield* fs.chmod(news.path, news.mode);
          }
          const hash = yield* sha256(news.content);
          return { path: news.path, hash };
        }),
        // Dotfiles predate and outlive any given machine-run stack — `alchemy
        // destroy` must never delete a real file on disk, so this is
        // deliberately a no-op (matching alchemy's own Command.Exec, whose
        // side effects are likewise never reversed on delete).
        delete: () => Effect.void,
      });
    }),
  );
