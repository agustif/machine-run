import { isNotFound, MachinePaths } from "@machine-run/core";
import { type Reconciler, toProvider } from "@machine-run/engine";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";

/**
 * The `known_hosts` key-type field, as OpenSSH itself writes it. Wider than
 * {@link import("./Key.ts").KeyAlgorithm} on purpose: this resource pins
 * entries a caller already obtained somehow (see this module's doc comment),
 * which may be for a host running an algorithm this repo has no generator
 * for at all.
 */
export const KnownHostKeyType = Schema.Literals([
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
]);

export type KnownHostKeyType = typeof KnownHostKeyType.Type;

export const KnownHostProps = Schema.Struct({
  /** Path to `known_hosts`. `~` is expanded. @default "~/.ssh/known_hosts" */
  path: Schema.optionalKey(Schema.String),
  /**
   * The hostname pattern exactly as `known_hosts` should carry it —
   * typically one hostname (`"github.com"`), but a comma-joined list
   * (`"github.com,140.82.121.3"`) is legal `known_hosts` syntax and is
   * passed through verbatim; this resource never edits it, only compares it
   * for an exact string match against what's already on a line.
   */
  host: Schema.String,
  keyType: KnownHostKeyType,
  /**
   * The base64 key material — the third whitespace-delimited field of a
   * `known_hosts` line, no `ssh-` prefix and no trailing comment. **Must be
   * obtained out of band** — see this module's doc comment.
   */
  publicKey: Schema.String,
  /** POSIX mode applied only when this resource creates the file for the first time. @default 0o644 */
  mode: Schema.optionalKey(Schema.Number),
  /** POSIX mode for directories created to hold it. @default 0o700 */
  directoryMode: Schema.optionalKey(Schema.Number),
});

export type KnownHostProps = typeof KnownHostProps.Type;

/**
 * What's on the matching line right now — which may not be what the recipe
 * asked for; see {@link KnownHostKeyMismatch}.
 */
export const KnownHostState = Schema.Struct({
  path: Schema.String,
  host: Schema.String,
  keyType: KnownHostKeyType,
  publicKey: Schema.String,
});

export type KnownHostState = typeof KnownHostState.Type;

export interface KnownHost extends Resource<"Ssh.KnownHost", KnownHostProps, KnownHostState> {}

export const KnownHost = Resource<KnownHost>("Ssh.KnownHost");

/** The file exists but could not be read — a permissions or I/O problem, not "nothing here yet". */
export class KnownHostsFileUnreadable extends Data.TaggedError("KnownHostsFileUnreadable")<{
  path: string;
  cause: PlatformError;
}> {
  override get message() {
    return `Could not read "${this.path}": ${this.cause.reason._tag}.`;
  }
}

/**
 * A line already exists for this exact `host`/`keyType` pair, but its key
 * material does not match the pinned `publicKey`. This is exactly the
 * situation trust-on-first-use exists to catch, and this resource refuses to
 * silently resolve it either way:
 *
 * - Overwriting the line would mean trusting whichever key this recipe
 *   happens to name *right now* over one that was already trusted — which,
 *   if the existing line is correct and `publicKey` is wrong (a stale pin,
 *   a copy-paste mistake), is the exact mistake pinning was meant to
 *   prevent.
 * - Appending a second line for the same `host`/`keyType` would leave the
 *   old, mismatched line in place *and still trusted* — `ssh` accepts a
 *   connection if *any* line matches the offered key, so the stale entry
 *   would keep being honored right alongside the new one. If the stale
 *   entry is the one that's wrong (a rotated or compromised key), that does
 *   not close the gap; it just adds a second door.
 *
 * So this resource raises instead of guessing, on both branches. Resolving
 * it is a human decision: remove the stale line (`ssh-keygen -R <host>` or a
 * text editor) if the pinned key is the correct one, or fix `publicKey` in
 * the recipe if the existing line was actually right.
 */
export class KnownHostKeyMismatch extends Data.TaggedError("KnownHostKeyMismatch")<{
  path: string;
  host: string;
  keyType: KnownHostKeyType;
  expected: string;
  actual: string;
}> {
  override get message() {
    return (
      `"${this.path}" already has a ${this.keyType} entry for "${this.host}" whose key does not match ` +
      `the pinned one. Refusing to guess whether the existing line or the pinned "publicKey" is the ` +
      `stale one — remove the existing line by hand (e.g. \`ssh-keygen -R ${this.host}\`) if the pin is ` +
      `correct, or fix the recipe's "publicKey" if the existing line was actually right.`
    );
  }
}

export type KnownHostError = PlatformError | KnownHostsFileUnreadable | KnownHostKeyMismatch;

export interface KnownHostEntry {
  readonly host: string;
  readonly keyType: string;
  readonly publicKey: string;
}

/**
 * Whether a `known_hosts` line carries nothing this parser interprets:
 * blank, a `#` comment, or a `@cert-authority`/`@revoked` marker line. The
 * marker forms are real, legal `known_hosts` syntax — skipped, not treated
 * as malformed — this resource simply has no opinion about them; see this
 * module's doc comment for what that means for `HashKnownHosts`, too.
 */
const isIgnoredLine = (line: string): boolean => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.startsWith("#")) return true;
  if (trimmed.startsWith("@")) return true;
  return false;
};

/**
 * Every plain `host keytype key [comment...]` line in a `known_hosts` file.
 * Pure and total, so it's testable without a filesystem.
 */
export const parseKnownHosts = (content: string): readonly KnownHostEntry[] => {
  const entries: KnownHostEntry[] = [];
  for (const line of content.split("\n")) {
    if (isIgnoredLine(line)) continue;
    const fields = line.trim().split(/\s+/);
    const host = fields[0];
    const keyType = fields[1];
    const publicKey = fields[2];
    if (host === undefined || keyType === undefined || publicKey === undefined) continue;
    entries.push({ host, keyType, publicKey });
  }
  return entries;
};

export const findKnownHostEntry = (
  entries: readonly KnownHostEntry[],
  host: string,
  keyType: string,
): KnownHostEntry | undefined =>
  entries.find((entry) => entry.host === host && entry.keyType === keyType);

/** Appends one line, adding a trailing newline to `content` first if it's missing one. */
export const appendKnownHostLine = (content: string, entry: KnownHostEntry): string => {
  const line = `${entry.host} ${entry.keyType} ${entry.publicKey}`;
  if (content.length === 0) return `${line}\n`;
  if (content.endsWith("\n")) return `${content}${line}\n`;
  return `${content}\n${line}\n`;
};

const DEFAULT_MODE = 0o644;
const DEFAULT_DIRECTORY_MODE = 0o700;
const DEFAULT_PATH = "~/.ssh/known_hosts";

/**
 * Pins one `host`/`keyType`/`publicKey` line in `known_hosts`.
 *
 * ## Why `publicKey` is a prop, never fetched
 *
 * The honest source of a host's key is `ssh-keyscan <host>` — but *trusting
 * whatever it returns* is trust-on-first-use by definition: the first
 * connection accepts whatever key is offered, with nothing to check it
 * against. A reconciler that ran `ssh-keyscan` itself and wrote the result
 * would automate exactly that TOFU accept step on every machine it touched,
 * which is the one thing a *pinning* resource must not do. So `publicKey`
 * is a required prop: the caller obtains it out of band (an out-of-band
 * fingerprint from the host's own documentation, a value copied from a
 * machine already known-good, or a `ssh-keyscan` run once by a human who
 * then verifies it against a published fingerprint) and this resource only
 * ever writes the exact bytes it was given.
 *
 * ## Why a mismatch fails instead of resolving itself
 *
 * See {@link KnownHostKeyMismatch}'s doc comment. In short: both "trust the
 * new pin" and "trust the old line" are guesses this resource is not
 * positioned to make safely, so it raises and leaves the decision to a human.
 *
 * ## Why this address is the whole file, not one entry
 *
 * `address` returns the expanded `path`, not `path:host:keyType` — so every
 * `Ssh.KnownHost` targeting the same file serialises through the same
 * `FileLock`, the same way `Dotfiles.ManagedBlock` addresses the whole file
 * rather than one marked region within it. Without that, two entries
 * appending to the same file concurrently (Alchemy applies with
 * `concurrency: "unbounded"`) could race on the read-modify-write and drop
 * one another's line.
 *
 * ## A known limitation: `HashKnownHosts`
 *
 * `parseKnownHosts` only recognises a literal hostname in the first field.
 * OpenSSH's `HashKnownHosts yes` (macOS's historical default) stores
 * `|1|<salt>|<hash>` instead, which this parser cannot match against a plain
 * `host` prop at all — an already-hashed file would never appear to already
 * contain an entry this resource is looking for, so it would append a
 * second, unhashed line for the same host. That's harmless (`ssh` accepts
 * either form), but it does mean this resource cannot report accurate drift
 * against a hashed file, only append blindly. Not fixed here — hashing
 * would need the same salt OpenSSH used, which this resource has no way to
 * discover from the file alone. See `packages/ssh/TASKS.md`.
 */
export const makeKnownHostReconciler: Effect.Effect<
  Reconciler<KnownHostProps, KnownHostState, KnownHostError>,
  never,
  FileSystem.FileSystem | Path.Path | MachinePaths
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* MachinePaths;

  const readContentOrEmpty = (target: string) =>
    fs.readFileString(target).pipe(
      Effect.catchTag("PlatformError", (cause) => {
        if (isNotFound(cause)) return Effect.succeed("");
        return Effect.fail(new KnownHostsFileUnreadable({ path: target, cause }));
      }),
    );

  return {
    address: (props) => paths.expand(props.path ?? DEFAULT_PATH),

    observe: (props) =>
      Effect.gen(function* () {
        const target = paths.expand(props.path ?? DEFAULT_PATH);
        const entries = parseKnownHosts(yield* readContentOrEmpty(target));
        const found = findKnownHostEntry(entries, props.host, props.keyType);
        if (found === undefined) return undefined;
        // Reports whatever is actually on the line — even when it doesn't
        // match `publicKey` — so `matches` below can tell the two cases
        // apart. Collapsing a mismatch into "absent" here would make
        // `apply` append a duplicate line instead of raising
        // `KnownHostKeyMismatch`. `keyType` is `props.keyType` rather than
        // `found.keyType` (both are equal by construction — `findKnownHostEntry`
        // filtered on exactly that value) so this needs no unsafe cast back
        // into the literal union.
        return {
          path: target,
          host: found.host,
          keyType: props.keyType,
          publicKey: found.publicKey,
        };
      }),

    desired: (props) =>
      Effect.succeed({
        path: paths.expand(props.path ?? DEFAULT_PATH),
        host: props.host,
        keyType: props.keyType,
        publicKey: props.publicKey,
      }),

    matches: (observed, desired) =>
      observed.path === desired.path &&
      observed.host === desired.host &&
      observed.keyType === desired.keyType &&
      observed.publicKey === desired.publicKey,

    apply: ({ props, observed, desired }) =>
      Effect.gen(function* () {
        // `observed` is only defined here when `matches` returned false —
        // i.e. a line already exists for this `host`/`keyType` but with a
        // different key. See `KnownHostKeyMismatch`'s doc comment for why
        // this resource will not decide which one is stale.
        if (observed !== undefined) {
          return yield* Effect.fail(
            new KnownHostKeyMismatch({
              path: desired.path,
              host: desired.host,
              keyType: desired.keyType,
              expected: desired.publicKey,
              actual: observed.publicKey,
            }),
          );
        }

        yield* fs.makeDirectory(path.dirname(desired.path), {
          recursive: true,
          mode: props.directoryMode ?? DEFAULT_DIRECTORY_MODE,
        });

        const existed = yield* fs.stat(desired.path).pipe(
          Effect.as(true),
          Effect.catchTag("PlatformError", (cause) => {
            if (isNotFound(cause)) return Effect.succeed(false);
            return Effect.fail(new KnownHostsFileUnreadable({ path: desired.path, cause }));
          }),
        );

        const current = yield* readContentOrEmpty(desired.path);
        const updated = appendKnownHostLine(current, {
          host: desired.host,
          keyType: desired.keyType,
          publicKey: desired.publicKey,
        });

        // Mode is only applied at creation — like `directoryMode` above and
        // `Machine.SecretFile`'s own `mode`, an existing file keeps whatever
        // bits it already had rather than being chmod'd on every apply, so
        // several entries sharing this file don't fight over which prop's
        // `mode` wins.
        if (existed) {
          yield* fs.writeFileString(desired.path, updated);
        } else {
          yield* fs.writeFileString(desired.path, updated, { mode: props.mode ?? DEFAULT_MODE });
        }

        return desired;
      }),
  };
});

export const KnownHostProvider = () => toProvider(KnownHost, makeKnownHostReconciler);
