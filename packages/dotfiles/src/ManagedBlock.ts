import { backupIfExists, sha256 } from "@machine-run/core";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * A marker-delimited block inside a file machine-run does NOT fully own —
 * e.g. `~/.zshrc`, `~/.gitconfig`, `~/.ssh/config`, which already carry
 * substantial hand-written content. Reconcile only ever touches the text
 * between `# machine-run:<marker> BEGIN` and `# machine-run:<marker> END`;
 * everything else in the file is preserved byte-for-byte.
 */
export interface ManagedBlockProps {
  /** Absolute path to the file. */
  path: string;
  /** Unique marker identifying this block; must be stable across runs. */
  marker: string;
  /** Desired content of the block, exclusive of the marker lines themselves. */
  content: string;
}

export interface ManagedBlock
  extends Resource<"Machine.ManagedBlock", ManagedBlockProps, { hash: string }> {}

export const ManagedBlock = Resource<ManagedBlock>("Machine.ManagedBlock");

const beginMarker = (marker: string) => `# machine-run:${marker} BEGIN`;
const endMarker = (marker: string) => `# machine-run:${marker} END`;

/** Replaces (or appends) the marked block within `existing`, leaving the rest of the file untouched. */
export const renderFile = (existing: string, marker: string, content: string) => {
  const begin = beginMarker(marker);
  const end = endMarker(marker);
  const block = `${begin}\n${content.replace(/\n+$/, "")}\n${end}`;

  const beginIndex = existing.indexOf(begin);
  const endIndex = existing.indexOf(end);
  if (beginIndex === -1 || endIndex === -1) {
    const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
    return `${existing}${needsLeadingNewline ? "\n" : ""}${block}\n`;
  }

  const before = existing.slice(0, beginIndex);
  const after = existing.slice(endIndex + end.length);
  return `${before}${block}${after}`;
};

export const ManagedBlockProvider = () =>
  Provider.effect(
    ManagedBlock,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      return ManagedBlock.Provider.of({
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
          // Snapshot the file before this resource's very first block
          // insertion — the only point where we're about to mutate a file we
          // don't otherwise own.
          if (!output) {
            yield* backupIfExists(news.path, path.join(dir, ".machine-run-backups"));
          }
          const exists = yield* fs.exists(news.path);
          const existing = exists ? yield* fs.readFileString(news.path) : "";
          const updated = renderFile(existing, news.marker, news.content);
          yield* fs.writeFileString(news.path, updated);
          const hash = yield* sha256(news.content);
          return { hash };
        }),
        // Never removes the block on destroy — see File.ts's delete for why.
        delete: () => Effect.void,
      });
    }),
  );
