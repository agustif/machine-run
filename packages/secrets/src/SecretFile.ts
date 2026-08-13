import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { OnePassword } from "./OnePassword.ts";

export interface SecretFileProps {
  /** Absolute path to write the secret to, e.g. `~/.ssh/id_ed25519_personal`. */
  path: string;
  /** A 1Password secret reference, e.g. `op://Personal/GitHub SSH Key/private key`. */
  opRef: string;
  /** POSIX file mode. @default 0o600 */
  mode?: number;
}

/**
 * Attributes deliberately carry only the path — never the secret's bytes, or
 * even a hash of them. Alchemy's local state is unencrypted JSON committed
 * to a private git repo, so nothing secret-derived may ever land in it.
 */
export interface SecretFile
  extends Resource<"Machine.SecretFile", SecretFileProps, { path: string }> {}

export const SecretFile = Resource<SecretFile>("Machine.SecretFile");

export const SecretFileProvider = () =>
  Provider.effect(
    SecretFile,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const onePassword = yield* OnePassword;

      return SecretFile.Provider.of({
        list: () => Effect.succeed([]),
        // Diffs on existence only — never on content or a content hash, so
        // 1Password stays the sole source of truth and nothing secret-shaped
        // is ever compared into (or read back out of) committed state.
        diff: Effect.fn(function* ({ news }) {
          if (!isResolved(news)) return undefined;
          const exists = yield* fs.exists(news.path);
          if (!exists) {
            return { action: "update" as const };
          }
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          yield* fs.makeDirectory(path.dirname(news.path), {
            recursive: true,
          });
          const secret = yield* onePassword.read(news.opRef, session);
          yield* fs.writeFileString(news.path, secret);
          yield* fs.chmod(news.path, news.mode ?? 0o600);
          return { path: news.path };
        }),
        // Never deletes a materialized secret file on `alchemy destroy` —
        // same rationale as the dotfiles resources.
        delete: () => Effect.void,
      });
    }),
  );
