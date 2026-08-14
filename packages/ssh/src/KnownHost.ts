import {
  detectLineEnding,
  DEFAULT_DIRECTORY_MODE,
  ensureParentDir,
  isNotFound,
  joinLines,
  MachinePaths,
  splitLines,
} from "@machine-run/core";
import { type Drift, type Reconciler, toProvider } from "@machine-run/engine";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Encoding from "effect/Encoding";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Result from "effect/Result";
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

/** A hashed `known_hosts` field was malformed or used an unsupported version. */
export class KnownHostsHashMalformed extends Data.TaggedError("KnownHostsHashMalformed")<{
  path: string;
  line: string;
}> {
  override get message() {
    return `"${this.path}" contains a malformed hashed known_hosts entry: "${this.line}". Refusing to append or remove a pin without understanding the file. Expected OpenSSH's |1|<base64-salt>|<base64-hash> form.`;
  }
}

/** WebCrypto could not calculate the OpenSSH known-host hash. */
export class KnownHostsHashFailed extends Data.TaggedError("KnownHostsHashFailed")<{
  host: string;
  cause: unknown;
}> {
  override get message() {
    return `Could not compare the hashed known_hosts entry for "${this.host}".`;
  }
}

export type KnownHostError =
  | PlatformError
  | KnownHostsFileUnreadable
  | KnownHostKeyMismatch
  | KnownHostsHashMalformed
  | KnownHostsHashFailed;

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

const isHashedHostField = (field: string): boolean => field.startsWith("|");

/**
 * A literal known_hosts host field may contain several comma-separated
 * hostnames. OpenSSH hashes those names independently when ssh-keygen -H
 * rewrites the file, so a resource that pins the original combined field must
 * try each candidate when matching or removing a hashed line.
 */
const hostCandidates = (host: string): readonly string[] =>
  host.split(",").filter((candidate) => candidate.length > 0);

interface HashedHostField {
  readonly salt: Uint8Array;
  readonly hash: Uint8Array;
}

const decodeBase64 = (value: string): Uint8Array | undefined =>
  Result.match(Encoding.decodeBase64(value), {
    onFailure: () => undefined,
    onSuccess: (decoded) => decoded,
  });

/** Parses OpenSSH's `|1|base64(salt)|base64(HMAC-SHA1(salt, host))` form. */
const parseHashedHostField = (field: string): HashedHostField | undefined => {
  const pieces = field.split("|");
  if (pieces.length !== 4 || pieces[1] !== "1") return undefined;
  const saltText = pieces[2];
  const hashText = pieces[3];
  if (saltText === undefined || hashText === undefined) return undefined;
  const salt = decodeBase64(saltText);
  const hash = decodeBase64(hashText);
  if (salt === undefined || hash === undefined) return undefined;
  return { salt, hash };
};

/**
 * OpenSSH uses HMAC-SHA1 here for protocol compatibility, not as a new secret
 * construction. The salt is stored in the file, so an existing hashed entry
 * can be matched without guessing or changing the host's trust material.
 */
const hashKnownHost = (
  host: string,
  salt: Uint8Array,
): Effect.Effect<Uint8Array, KnownHostsHashFailed> =>
  Effect.tryPromise({
    try: () =>
      globalThis.crypto.subtle
        .importKey("raw", salt, { name: "HMAC", hash: "SHA-1" }, false, ["sign"])
        .then((key) => globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(host)))
        .then((signature) => new Uint8Array(signature)),
    catch: (cause) => new KnownHostsHashFailed({ host, cause }),
  });

/**
 * Finds a matching hashed host entry. A malformed hashed line is an error, not
 * an absent host: silently appending a second line would make trust state
 * impossible to reason about.
 */
const findHashedHostEntry = (
  content: string,
  path: string,
  host: string,
  keyType: string,
): Effect.Effect<KnownHostEntry | undefined, KnownHostsHashMalformed | KnownHostsHashFailed> =>
  Effect.gen(function* () {
    for (const line of splitLines(content)) {
      if (isIgnoredLine(line)) continue;
      const fields = line.trim().split(/\s+/);
      const hostField = fields[0];
      if (hostField === undefined || !isHashedHostField(hostField)) continue;
      const hashed = parseHashedHostField(hostField);
      const actualKeyType = fields[1];
      const publicKey = fields[2];
      if (hashed === undefined || actualKeyType === undefined || publicKey === undefined) {
        return yield* Effect.fail(new KnownHostsHashMalformed({ path, line }));
      }
      if (actualKeyType !== keyType) continue;
      for (const candidate of hostCandidates(host)) {
        const expectedHash = yield* hashKnownHost(candidate, hashed.salt);
        if (Encoding.encodeBase64(expectedHash) === Encoding.encodeBase64(hashed.hash)) {
          return { host, keyType: actualKeyType, publicKey };
        }
      }
    }
    return undefined;
  });

/**
 * Every plain `host keytype key [comment...]` line in a `known_hosts` file.
 * Pure and total, so it's testable without a filesystem.
 */
export const parseKnownHosts = (content: string): readonly KnownHostEntry[] => {
  const entries: KnownHostEntry[] = [];
  // `splitLines`, not a raw `content.split("\n")`: `line.trim()` below
  // happens to strip a lone trailing `\r` too (it is a LineTerminator
  // character as far as `String.prototype.trim` is concerned), so this
  // parser's own field extraction was never actually fooled by one. But
  // relying on that is exactly the kind of accidental correctness this
  // module's other two siblings (`LineInFile`, `ManagedBlock`) got wrong in
  // a more consequential way — a future edit that reads a field without
  // trimming first (or trims only the host/keyType and forwards `publicKey`
  // raw) would silently reintroduce the bug `trim()` currently happens to
  // paper over. Splitting correctly in the first place removes the
  // dependency on that coincidence.
  for (const line of splitLines(content)) {
    if (isIgnoredLine(line)) continue;
    const fields = line.trim().split(/\s+/);
    const host = fields[0];
    const keyType = fields[1];
    const publicKey = fields[2];
    if (
      host === undefined ||
      keyType === undefined ||
      publicKey === undefined ||
      isHashedHostField(host)
    )
      continue;
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

/**
 * Appends one line, adding a trailing terminator to `content` first if it's
 * missing one — in whichever line ending `content` already uses (`"lf"` for
 * empty content, since there is nothing there to preserve; see
 * `LineEndings.ts`'s doc comment). A CRLF `known_hosts` — Windows OpenSSH's
 * own convention — otherwise ends up with every line but the last one
 * terminated by `\r\n` and the newest line terminated by a bare `\n`, a
 * mixed file this tool itself introduced.
 */
export const appendKnownHostLine = (content: string, entry: KnownHostEntry): string => {
  const line = `${entry.host} ${entry.keyType} ${entry.publicKey}`;
  const ending = detectLineEnding(content);
  return joinLines([...splitLines(content), line], ending);
};

/**
 * Drops every line matching `entry` exactly on `host`/`keyType`/`publicKey` —
 * the real reverse of {@link appendKnownHostLine}. Comment and marker lines
 * are never touched, matching {@link parseKnownHosts}'s own disinterest in
 * them.
 */
export const removeKnownHostLine = (content: string, entry: KnownHostEntry): string => {
  const ending = detectLineEnding(content);
  const kept = splitLines(content).filter((line) => {
    if (isIgnoredLine(line)) return true;
    const fields = line.trim().split(/\s+/);
    return !(
      fields[0] === entry.host &&
      fields[1] === entry.keyType &&
      fields[2] === entry.publicKey
    );
  });
  return joinLines(kept, ending);
};

const DEFAULT_MODE = 0o644;
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
 * ## `HashKnownHosts`
 *
 * OpenSSH stores `|1|<salt>|<HMAC-SHA1>` when hashing is enabled. The salt is
 * part of the line, so the resource can calculate the same HMAC and match the
 * host without ever changing the pinned key. New entries remain literal: the
 * caller owns the file's policy, and OpenSSH itself can hash them later with
 * `ssh-keygen -H`. Malformed hashed lines fail loudly rather than causing a
 * duplicate trust entry to be appended.
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
        const content = yield* readContentOrEmpty(target);
        const entries = parseKnownHosts(content);
        const found = findKnownHostEntry(entries, props.host, props.keyType);
        const hashed =
          found === undefined
            ? yield* findHashedHostEntry(content, target, props.host, props.keyType)
            : undefined;
        const matched = found ?? hashed;
        if (matched === undefined) return Option.none();
        // Reports whatever is actually on the line — even when it doesn't
        // match `publicKey` — so `matches` below can tell the two cases
        // apart. Collapsing a mismatch into "absent" here would make
        // `apply` append a duplicate line instead of raising
        // `KnownHostKeyMismatch`. `keyType` is `props.keyType` rather than
        // `found.keyType` (both are equal by construction — `findKnownHostEntry`
        // filtered on exactly that value) so this needs no unsafe cast back
        // into the literal union.
        return Option.some({
          path: target,
          host: matched.host,
          keyType: props.keyType,
          publicKey: matched.publicKey,
        });
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

    // Every field here is categorical, not ordered — no `direction`.
    drift: (observed, desired): Drift => {
      const fields = [];
      if (observed.path !== desired.path) {
        fields.push({ field: "path", observed: observed.path, desired: desired.path });
      }
      if (observed.host !== desired.host) {
        fields.push({ field: "host", observed: observed.host, desired: desired.host });
      }
      if (observed.keyType !== desired.keyType) {
        fields.push({ field: "keyType", observed: observed.keyType, desired: desired.keyType });
      }
      if (observed.publicKey !== desired.publicKey) {
        fields.push({ field: "key", observed: observed.publicKey, desired: desired.publicKey });
      }
      return fields;
    },

    apply: ({ props, observed, desired }) =>
      Effect.gen(function* () {
        // `observed` is only `Option.some` here when `matches` returned false
        // — i.e. a line already exists for this `host`/`keyType` but with a
        // different key. See `KnownHostKeyMismatch`'s doc comment for why
        // this resource will not decide which one is stale.
        if (Option.isSome(observed)) {
          return yield* Effect.fail(
            new KnownHostKeyMismatch({
              path: desired.path,
              host: desired.host,
              keyType: desired.keyType,
              expected: desired.publicKey,
              actual: observed.value.publicKey,
            }),
          );
        }

        yield* ensureParentDir(
          fs,
          path,
          desired.path,
          props.directoryMode ?? DEFAULT_DIRECTORY_MODE,
        );

        const existed = yield* fs.stat(desired.path).pipe(
          Effect.as(true),
          Effect.catchTag("PlatformError", (cause) => {
            if (isNotFound(cause)) return Effect.succeed(false);
            return Effect.fail(new KnownHostsFileUnreadable({ path: desired.path, cause }));
          }),
        );

        const current = yield* readContentOrEmpty(desired.path);
        const currentEntries = parseKnownHosts(current);
        const currentLiteral = findKnownHostEntry(currentEntries, desired.host, desired.keyType);
        if (currentLiteral !== undefined) {
          if (currentLiteral.publicKey !== desired.publicKey) {
            return yield* Effect.fail(
              new KnownHostKeyMismatch({
                path: desired.path,
                host: desired.host,
                keyType: desired.keyType,
                expected: desired.publicKey,
                actual: currentLiteral.publicKey,
              }),
            );
          }
          return desired;
        }
        const currentHashed = yield* findHashedHostEntry(
          current,
          desired.path,
          desired.host,
          desired.keyType,
        );
        if (currentHashed !== undefined) {
          if (currentHashed.publicKey !== desired.publicKey) {
            return yield* Effect.fail(
              new KnownHostKeyMismatch({
                path: desired.path,
                host: desired.host,
                keyType: desired.keyType,
                expected: desired.publicKey,
                actual: currentHashed.publicKey,
              }),
            );
          }
          return desired;
        }
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

    /**
     * Removes the exact line `apply` wrote — a real, safe reverse: unlike
     * `Ssh.Key`, nothing here is unrecoverable (the same line can always be
     * re-pinned from the same out-of-band source that produced it the first
     * time).
     *
     * Only when `observed`'s key still matches `recorded`'s: if the line has
     * since changed to something else (hand-edited, or re-pinned to a
     * different key by a later run), it is no longer this resource's own
     * contribution to remove — deleting it would be exactly the kind of
     * guess {@link KnownHostKeyMismatch} refuses to make on `apply`'s side,
     * so `unapply` refuses it too and leaves the file untouched.
     */
    unapply: ({ recorded, observed }) =>
      observed.publicKey !== recorded.publicKey
        ? Effect.void
        : Effect.gen(function* () {
            const current = yield* readContentOrEmpty(recorded.path);
            const ending = detectLineEnding(current);
            const kept: string[] = [];
            for (const line of splitLines(current)) {
              if (isIgnoredLine(line)) {
                kept.push(line);
                continue;
              }
              const fields = line.trim().split(/\s+/);
              const hostField = fields[0];
              const keyType = fields[1];
              const publicKey = fields[2];
              if (
                hostField === recorded.host &&
                keyType === recorded.keyType &&
                publicKey === recorded.publicKey
              ) {
                continue;
              }
              if (hostField !== undefined && isHashedHostField(hostField)) {
                const hashed = parseHashedHostField(hostField);
                if (hashed === undefined || keyType === undefined || publicKey === undefined) {
                  return yield* Effect.fail(
                    new KnownHostsHashMalformed({ path: recorded.path, line }),
                  );
                }
                if (keyType === recorded.keyType && publicKey === recorded.publicKey) {
                  let matches = false;
                  for (const candidate of hostCandidates(recorded.host)) {
                    const expectedHash = yield* hashKnownHost(candidate, hashed.salt);
                    if (
                      Encoding.encodeBase64(expectedHash) === Encoding.encodeBase64(hashed.hash)
                    ) {
                      matches = true;
                      break;
                    }
                  }
                  if (matches) continue;
                }
              }
              kept.push(line);
            }
            yield* fs.writeFileString(recorded.path, joinLines(kept, ending));
          }),
  };
});

export const KnownHostProvider = () => toProvider(KnownHost, makeKnownHostReconciler);
