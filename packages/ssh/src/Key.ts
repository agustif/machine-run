import {
  DEFAULT_DIRECTORY_MODE,
  ensureParentDir,
  isNotFound,
  MachinePaths,
  Platform,
  Timeouts,
} from "@machine-run/core";
import { type Drift, type Reconciler, toProvider } from "@machine-run/engine";
import type { CommandError } from "alchemy/Command";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { PlatformError, systemError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { sshCommand } from "./command.ts";

/**
 * `ssh-keygen -t` algorithm names — the ones this resource knows how to
 * generate. Deliberately narrower than every type OpenSSH's `known_hosts`
 * can hold (see {@link import("./KnownHost.ts").KnownHostKeyType}): a
 * generator only needs to offer the algorithms worth minting new keys with
 * today, not every algorithm an adopted machine might already be using.
 */
export const KeyAlgorithm = Schema.Literals(["ed25519", "rsa", "ecdsa"]);
export type KeyAlgorithm = typeof KeyAlgorithm.Type;

export const KeyProps = Schema.Struct({
  /** Path to the private key, e.g. `~/.ssh/id_ed25519_personal`. `~` is expanded. */
  path: Schema.String,
  /** `ssh-keygen -t` algorithm. @default "ed25519" */
  algorithm: Schema.optionalKey(KeyAlgorithm),
  /**
   * `ssh-keygen -b`. Meaningless for `"ed25519"` (OpenSSH silently ignores
   * `-b` for it — verified: `ssh-keygen -t ed25519 -b 256 ...` exits `0` and
   * produces an ordinary 256-bit key regardless). For `"rsa"` this is the
   * modulus length (OpenSSH's own default is 3072); for `"ecdsa"` it is the
   * curve size and must be one of `256`, `384`, `521`.
   */
  bits: Schema.optionalKey(Schema.Number),
  /**
   * `ssh-keygen -C`. Always passed explicitly by this resource, defaulting
   * to `""` when unset — never left to OpenSSH's own default, which is
   * `<user>@<host>` of the machine ssh-keygen happened to run on (verified:
   * an unset `-C` on this machine produced the comment `a@192.168.1.82`).
   * Baking a byproduct of *where this ran* into a *public* key that may be
   * copied into someone else's `authorized_keys` is a mild, avoidable leak,
   * and it would make repeated generation non-deterministic for no benefit.
   */
  comment: Schema.optionalKey(Schema.String),
  /** POSIX mode for the private key file. @default 0o600 */
  mode: Schema.optionalKey(Schema.Number),
  /** POSIX mode for directories created to hold it. @default 0o700 */
  directoryMode: Schema.optionalKey(Schema.Number),
});

export type KeyProps = typeof KeyProps.Type;

/**
 * What this resource can honestly report about a keypair without ever
 * reading the private key's bytes: where both halves live, the wire-format
 * algorithm and comment carried by the *public* half (read straight from
 * `<path>.pub`, which is meant to be shared), and a fingerprint (derived via
 * `ssh-keygen -lf`, itself a one-way hash of the public half). None of this
 * is secret; all of it is safe to persist in Alchemy's unencrypted
 * `localState()` — see this module's doc comment for why the private key
 * itself never appears here.
 *
 * `comment`, `publicKeyType` and `fingerprint` are only ever populated by
 * `observe`/`apply`, once both halves exist to read — see
 * {@link makeKeyReconciler}'s `desired` for why they cannot be known ahead
 * of generation.
 */
export const KeyState = Schema.Struct({
  path: Schema.String,
  publicKeyPath: Schema.String,
  /** The wire-format algorithm name read from `<path>.pub`, e.g. `"ssh-ed25519"` — not the `-t` value that created it. */
  publicKeyType: Schema.optionalKey(Schema.String),
  comment: Schema.optionalKey(Schema.String),
  /** `SHA256:...` — from `ssh-keygen -lf`. */
  fingerprint: Schema.optionalKey(Schema.String),
});

export type KeyState = typeof KeyState.Type;

export interface Key extends Resource<"Ssh.Key", KeyProps, KeyState> {}

export const Key = Resource<Key>("Ssh.Key");

/**
 * A path could not be inspected at all — not "nothing there", but a
 * permissions or I/O problem underneath it. Collapsing this into "absent"
 * would let `apply` go on to run `ssh-keygen` against a path whose real
 * problem is invisibility, not emptiness.
 */
export class KeyPathUnreadable extends Data.TaggedError("KeyPathUnreadable")<{
  path: string;
  cause: PlatformError;
}> {
  override get message() {
    return `Could not inspect "${this.path}": ${this.cause.reason._tag}.`;
  }
}

/**
 * Exactly one half of a keypair exists on disk: the private key with no
 * `.pub`, or a `.pub` with no private key. Neither is a state this resource
 * can guess its way through — a lone private key might be intact and just
 * missing its derived public half (recoverable with `ssh-keygen -y`, by
 * hand, deliberately not automated here since it would mean this resource
 * reading private key bytes for the one and only time it would ever need
 * to), and a lone `.pub` with no private key is a public key someone placed
 * there for an unrelated reason. Generating into either case would either
 * silently fail (`ssh-keygen` refuses to overwrite an existing private key
 * non-interactively — verified below) or silently create a second, unrelated
 * keypair next to a stray `.pub`. Fail loudly instead; a human resolves it.
 */
export class KeyPairIncomplete extends Data.TaggedError("KeyPairIncomplete")<{
  path: string;
  publicKeyPath: string;
  missing: "private" | "public";
}> {
  override get message() {
    if (this.missing === "private") {
      return `"${this.publicKeyPath}" exists but "${this.path}" does not — a public key with no matching private key. Not something this resource will guess its way through; resolve it by hand.`;
    }
    return `"${this.path}" exists but "${this.publicKeyPath}" does not — a private key with no derived public half. Not something this resource will guess its way through; resolve it by hand (\`ssh-keygen -y -f ${this.path} > ${this.publicKeyPath}\` if you're certain the private key is intact).`;
  }
}

/** `<path>.pub`'s content is not `<type> <base64> [comment]` — too short to be a public key line at all. */
export class KeyPublicKeyMalformed extends Data.TaggedError("KeyPublicKeyMalformed")<{
  publicKeyPath: string;
  content: string;
}> {
  override get message() {
    return `"${this.publicKeyPath}" does not look like an OpenSSH public key (expected "<type> <base64-material> [comment]"). Someone or something has overwritten it.`;
  }
}

/** `ssh-keygen -lf`'s output did not contain a `SHA256:...` fingerprint field where expected. */
export class KeyFingerprintUnparseable extends Data.TaggedError("KeyFingerprintUnparseable")<{
  publicKeyPath: string;
  output: string;
}> {
  override get message() {
    return `"ssh-keygen -lf ${this.publicKeyPath}" did not print a SHA256 fingerprint in the expected shape. Got: "${this.output}".`;
  }
}

/**
 * `ssh-keygen -b` accepts only the three named NIST curve sizes for ECDSA.
 * Validate this before creating a directory or invoking the command so a bad
 * recipe fails at planning time with a stable, typed error rather than a
 * backend-specific stderr string.
 */
export class KeyEcdsaBitsInvalid extends Data.TaggedError("KeyEcdsaBitsInvalid")<{
  bits: number;
  allowed: readonly [256, 384, 521];
}> {
  override get message() {
    return `Ssh.Key algorithm "ecdsa" requires bits to be one of ${this.allowed.join(", ")}; received ${this.bits}.`;
  }
}

export type KeyError =
  | PlatformError
  | CommandError
  | KeyPathUnreadable
  | KeyPairIncomplete
  | KeyPublicKeyMalformed
  | KeyFingerprintUnparseable
  | KeyEcdsaBitsInvalid;

/**
 * The public half of a keypair, as `<path>.pub` actually spells it:
 * `<wire-type> <base64-material> [comment]`. `comment` may itself contain
 * spaces (`ssh-keygen -C "work laptop"` is legal), so this takes everything
 * after the second field rather than assuming a fixed field count.
 *
 * Deliberately does not use `ssh-keygen -lf`'s own comment field for this —
 * `ssh-keygen -lf` prints the literal text `no comment` when a key carries
 * none (verified: `ssh-keygen -t ed25519 -f k -C "" -N ""` then
 * `ssh-keygen -lf k.pub` prints `... no comment (ED25519)`), which is
 * indistinguishable from a key whose actual comment happens to be the string
 * `no comment`. Reading the `.pub` file directly has no such ambiguity.
 */
export interface ParsedPublicKey {
  readonly keyType: string;
  readonly comment: string;
}

export const parsePublicKey = (content: string): ParsedPublicKey | undefined => {
  const fields = content.trim().split(/\s+/);
  const keyType = fields[0];
  const material = fields[1];
  if (keyType === undefined || material === undefined) return undefined;
  return { keyType, comment: fields.slice(2).join(" ") };
};

/**
 * Pulls the `SHA256:...` fingerprint out of one line of `ssh-keygen -lf`
 * output (`"<bits> SHA256:<hash> <comment...> (<TYPE>)"`). Takes the second
 * whitespace field specifically, rather than scanning for a `SHA256:` prefix
 * anywhere in the line, so a comment that happens to contain the literal
 * text `SHA256:` can never be mistaken for the real one.
 */
export const parseFingerprint = (output: string): string | undefined => {
  const fields = output.trim().split(/\s+/);
  const fingerprint = fields[1];
  if (fingerprint === undefined) return undefined;
  if (!fingerprint.startsWith("SHA256:")) return undefined;
  return fingerprint;
};

const DEFAULT_MODE = 0o600;
/**
 * Generates and manages one SSH keypair on this machine.
 *
 * ## Alchemy's `KeyPair` was considered and rejected
 *
 * Alchemy ships a generic `KeyPair` resource (`alchemy/src/KeyPair.ts`) that
 * generates a keypair with `node:crypto` and returns it as ordinary
 * `Resource` output. It was read directly rather than assumed, per this
 * repo's rule to verify APIs against shipped source, and two things rule it
 * out:
 *
 * 1. **It persists the private key in Alchemy's state.** Its own doc
 *    comment says so explicitly: "generated once on first reconcile and then
 *    persisted in state". This repo uses `Alchemy.localState()` — an
 *    unencrypted JSON file — so bridging `KeyPair` here would mean writing a
 *    plaintext SSH private key into a state file with none of `~/.ssh`'s
 *    `0600` handling, which is a strictly worse security posture than
 *    `ssh-keygen` ever leaving the key under `~/.ssh` in the first place.
 *    `@machine-run/secrets`' `Machine.SecretFile` stores only a *mode*, never
 *    a hash or the value itself, for exactly this reason (see its own doc
 *    comment) — `Ssh.Key` follows the same rule: nothing derived from the
 *    private key's bytes crosses into `KeyState`, only from the public half.
 * 2. **Wrong wire format.** `KeyPair`'s output is PEM `pkcs8`/`spki` — not
 *    the `known_hosts`/`authorized_keys` wire format (`ssh-ed25519 AAAA...`)
 *    that OpenSSH tooling actually reads — so the public half would need
 *    converting before it was useful to `ssh` at all.
 *
 * So this resource shells out to the real `ssh-keygen` and lets the private
 * key live only where OpenSSH itself expects it: on disk, under the
 * directory this resource creates at `0700`, never round-tripped through
 * this process's memory as a string handed back to Alchemy.
 *
 * ## Why there is no `unapply`
 *
 * `destroy` on this resource does nothing (the engine's default), and it
 * genuinely cannot do anything else: the private key is not derivable from
 * anything this resource — or Alchemy's state — retains. Deleting the file
 * on `destroy` would be an *irreversible* loss of key material with no way
 * back, which is a strictly worse outcome than leaving a keypair nobody
 * asked to remove sitting on disk. See `@machine-run/engine`'s
 * `Reconciler.unapply` doc comment for the general version of this argument.
 *
 * ## Why `matches` always reports convergence
 *
 * Once *anything* exists at `path`/`path.pub`, this resource treats itself as
 * satisfied — permanently, regardless of whether `algorithm`, `bits`, or
 * `comment` in the recipe still match what's on disk. This is deliberate,
 * not an oversight: the only way to make an existing keypair "match" a
 * changed `algorithm` prop would be to regenerate it, which is exactly the
 * unrecoverable operation the previous section explains this resource must
 * never do. So those props are consulted exactly once — the run that creates
 * the file — and are inert afterward. Changing them in a recipe has no
 * effect until the file is deleted by hand and generation runs again.
 *
 * This is also why `ssh-keygen` itself is a second line of defense, not the
 * only one: verified directly (`ssh-keygen -t ed25519 -f <existing> -N ""
 * </dev/null`) that it prompts `Overwrite (y/n)?` and, fed a closed stdin,
 * exits `1` leaving the existing private key untouched. `apply` here never
 * reaches that prompt in the first place, because it only ever runs
 * `ssh-keygen` when `observed` is `Option.none()`.
 */
export const makeKeyReconciler: Effect.Effect<
  Reconciler<KeyProps, KeyState, KeyError>,
  never,
  FileSystem.FileSystem | Path.Path | MachinePaths | Platform
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* MachinePaths;
  const platform = yield* Platform;

  const validate = (props: KeyProps) => {
    const algorithm = props.algorithm ?? "ed25519";
    const allowed: readonly [256, 384, 521] = [256, 384, 521];
    if (
      algorithm === "ecdsa" &&
      props.bits !== undefined &&
      !allowed.some((allowedBits) => allowedBits === props.bits)
    ) {
      return new KeyEcdsaBitsInvalid({ bits: props.bits, allowed });
    }
    return undefined;
  };

  const exists = (target: string) =>
    fs.stat(target).pipe(
      Effect.as(true),
      Effect.catchTag("PlatformError", (cause) => {
        if (isNotFound(cause)) return Effect.succeed(false);
        return Effect.fail(new KeyPathUnreadable({ path: target, cause }));
      }),
    );

  /**
   * Reads the live keypair at `privatePath`/`publicPath`, or `undefined` if
   * neither half exists yet. Never opens the private key file — presence is
   * checked with `stat`, never `readFileString`.
   */
  const readKeyState = (privatePath: string, publicPath: string) =>
    Effect.gen(function* () {
      const [hasPrivate, hasPublic] = yield* Effect.all([exists(privatePath), exists(publicPath)]);

      if (!hasPrivate && !hasPublic) return undefined;
      if (hasPrivate && !hasPublic) {
        return yield* Effect.fail(
          new KeyPairIncomplete({
            path: privatePath,
            publicKeyPath: publicPath,
            missing: "public",
          }),
        );
      }
      if (!hasPrivate && hasPublic) {
        return yield* Effect.fail(
          new KeyPairIncomplete({
            path: privatePath,
            publicKeyPath: publicPath,
            missing: "private",
          }),
        );
      }

      const publicContent = yield* fs.readFileString(publicPath);
      const parsed = parsePublicKey(publicContent);
      if (parsed === undefined) {
        return yield* Effect.fail(
          new KeyPublicKeyMalformed({ publicKeyPath: publicPath, content: publicContent }),
        );
      }

      return { privatePath, publicPath, keyType: parsed.keyType, comment: parsed.comment };
    });

  return {
    address: (props) => paths.expand(props.path),

    observe: (props, ctx) =>
      Effect.gen(function* () {
        const privatePath = paths.expand(props.path);
        const publicPath = `${privatePath}.pub`;
        const found = yield* readKeyState(privatePath, publicPath);
        if (found === undefined) return Option.none();

        const fingerprintOutput = yield* ctx.exec(sshCommand(platform, "-lf", found.publicPath));
        const fingerprint = parseFingerprint(fingerprintOutput.stdout);
        if (fingerprint === undefined) {
          return yield* Effect.fail(
            new KeyFingerprintUnparseable({
              publicKeyPath: found.publicPath,
              output: fingerprintOutput.stdout,
            }),
          );
        }

        return Option.some({
          path: found.privatePath,
          publicKeyPath: found.publicPath,
          publicKeyType: found.keyType,
          comment: found.comment,
          fingerprint,
        });
      }),

    // `comment`/`publicKeyType`/`fingerprint` are left unset: a comment
    // default of `""` is knowable ahead of generation, but recording it here
    // would suggest it participates in the comparison below, which it never
    // does — see "Why `matches` always reports convergence" above.
    desired: (props) => {
      const invalid = validate(props);
      return invalid === undefined
        ? Effect.succeed({
            path: paths.expand(props.path),
            publicKeyPath: `${paths.expand(props.path)}.pub`,
          })
        : Effect.fail(invalid);
    },

    // See this module's doc comment, "Why `matches` always reports
    // convergence" — this is the resource-level guarantee that an existing
    // keypair is never regenerated.
    matches: () => true,

    // Must agree with `matches` above, which is unconditionally `true` — so
    // this is unconditionally `[]`, never comparing `algorithm`/`bits`/
    // `comment` against what's on disk. This is also what keeps the private
    // key out of plan output for free: there is nothing to report, so
    // nothing derived from the private key's bytes (which this resource
    // never reads in the first place — see the module doc comment) can ever
    // reach a `DriftField`.
    drift: (): Drift => [],

    apply: ({ props, observed, desired }, ctx) =>
      Effect.gen(function* () {
        const invalid = validate(props);
        if (invalid !== undefined) return yield* Effect.fail(invalid);

        // `matches` above guarantees the engine only reaches here when
        // `observed` is `Option.none()` — this branch is unreachable in
        // practice, but returning the untouched state is the honest answer
        // if it were ever reached some other way, not a defect to raise.
        if (Option.isSome(observed)) return observed.value;

        yield* ensureParentDir(
          fs,
          path,
          desired.path,
          props.directoryMode ?? DEFAULT_DIRECTORY_MODE,
        );

        const algorithm = props.algorithm ?? "ed25519";
        const comment = props.comment ?? "";
        // `sshCommand` supplies the executable itself; keep this list as the
        // arguments only. Passing `ssh-keygen` here too would produce
        // `ssh-keygen ssh-keygen ...`, which OpenSSH rejects as "Too many
        // arguments" on every supported platform.
        const argv = ["-t", algorithm, "-f", desired.path, "-C", comment, "-N", ""];
        // `-b` is only meaningful for "rsa" (modulus length) and "ecdsa"
        // (curve size); OpenSSH silently ignores it for "ed25519" (verified
        // above), but omitting it there keeps the command honest about what
        // it actually controls.
        if (props.bits !== undefined && algorithm !== "ed25519") {
          argv.push("-b", String(props.bits));
        }

        yield* ctx.exec({ ...sshCommand(platform, ...argv), timeout: Timeouts.quickCommand });
        yield* fs.chmod(desired.path, props.mode ?? DEFAULT_MODE);

        const generated = yield* readKeyState(desired.path, desired.publicKeyPath);
        if (generated === undefined) {
          // ssh-keygen exited 0 but left nothing behind — treat as the same
          // "cannot inspect what should be there" failure as any other
          // unreadable path, rather than silently reporting success.
          return yield* Effect.fail(
            new KeyPathUnreadable({
              path: desired.path,
              cause: systemError({
                _tag: "NotFound",
                module: "FileSystem",
                method: "stat",
                description: "ssh-keygen reported success but wrote nothing",
              }),
            }),
          );
        }

        const fingerprintOutput = yield* ctx.exec(
          sshCommand(platform, "-lf", desired.publicKeyPath),
        );
        const fingerprint = parseFingerprint(fingerprintOutput.stdout);
        if (fingerprint === undefined) {
          return yield* Effect.fail(
            new KeyFingerprintUnparseable({
              publicKeyPath: desired.publicKeyPath,
              output: fingerprintOutput.stdout,
            }),
          );
        }

        return {
          path: desired.path,
          publicKeyPath: desired.publicKeyPath,
          publicKeyType: generated.keyType,
          comment: generated.comment,
          fingerprint,
        };
      }),
  };
});

export const KeyProvider = () => toProvider(Key, makeKeyReconciler);
