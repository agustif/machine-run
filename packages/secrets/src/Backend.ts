import type { CommandError } from "alchemy/Command";
import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Exec } from "@machine-run/engine";


/**
 * Every secret store this repo knows how to read from.
 *
 * Adding one means writing a single `backends/<Name>.ts` module and adding
 * its id here — the same seam `system-packages` uses for package managers.
 * `Machine.SecretFile` names a store by id and never depends on a particular
 * one, so a store can be added without touching the resource.
 */
export const SecretBackendId = Schema.Literals([
  "1password",
  "doppler",
  "keychain",
  "pass",
  "env",
]);

export type SecretBackendId = typeof SecretBackendId.Type;

/** The CLI for a backend isn't installed, or isn't on PATH. */
export class SecretCliMissing extends Data.TaggedError("SecretCliMissing")<{
  backend: SecretBackendId;
  cli: string;
  install: string;
  cause: CommandError;
}> {
  override get message() {
    return `The ${this.backend} CLI ("${this.cli}") is not installed or not on PATH. ${this.install}`;
  }
}

/**
 * The backend's CLI is installed but not authenticated.
 *
 * machine-run deliberately never automates this: a reconciler that can mint
 * its own credentials to a secret store is a reconciler that can exfiltrate
 * every secret in it without a human present.
 */
export class SecretAuthRequired extends Data.TaggedError("SecretAuthRequired")<{
  backend: SecretBackendId;
  signInCommand: string;
  cause: CommandError;
}> {
  override get message() {
    return `The ${this.backend} CLI is not signed in. Run \`${this.signInCommand}\` yourself — machine-run deliberately never automates authentication.`;
  }
}

/**
 * The store is reachable and authenticated, but this reference didn't
 * resolve. `cause` is absent for backends that don't shell out (`env`).
 */
export class SecretReadFailed extends Data.TaggedError("SecretReadFailed")<{
  backend: SecretBackendId;
  ref: string;
  cause: CommandError | undefined;
}> {
  override get message() {
    return `Failed to read "${this.ref}" from ${this.backend}.`;
  }
}

/**
 * The reference is not in the shape this backend accepts — caught before any
 * command runs, so it carries no `CommandError` cause.
 */
export class SecretRefInvalid extends Data.TaggedError("SecretRefInvalid")<{
  backend: SecretBackendId;
  ref: string;
  expected: string;
}> {
  override get message() {
    return `"${this.ref}" is not a valid ${this.backend} reference. Expected ${this.expected}.`;
  }
}

export type SecretError =
  | SecretCliMissing
  | SecretAuthRequired
  | SecretReadFailed
  | SecretRefInvalid;

/**
 * One secret store.
 *
 * `read` returns a {@link Redacted.Redacted} rather than a bare `string`.
 * That's not decoration: Alchemy's command redactor only scrubs values it
 * knows are secret, and a bare string is one careless template literal away
 * from a `CommandError` message, a log line, or `ps` output. Making the
 * secret type-level opaque means unwrapping it is a visible, greppable act.
 */
export interface SecretBackend {
  readonly id: SecretBackendId;
  /**
   * Resolves a backend-specific reference to its value.
   *
   * The value is returned **verbatim**. Whitespace can be significant — an
   * OpenSSH private key is rejected as malformed without its trailing
   * newline — so trimming is a decision only the consumer can make, and
   * `Machine.SecretFile` exposes it as an explicit policy.
   */
  readonly read: (
    ref: string,
    exec: Exec,
  ) => Effect.Effect<Redacted.Redacted<string>, SecretError>;
}
