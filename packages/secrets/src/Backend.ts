import type { CommandError } from "alchemy/Command";
import type { Exec } from "@machine-run/engine";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as UndefinedOr from "effect/UndefinedOr";

/**
 * One secret reference, typed per store.
 *
 * Every store this repo knows how to read from addresses a secret with its
 * own grammar — a 1Password secret reference is a vault/item/field triple, a
 * Doppler reference is a project/config/name triple, a keychain entry is a
 * service with an optional account, a `pass` entry is a store path, and an
 * environment variable is just a name. A single `Schema.String` field can't
 * tell these apart, so `{ source: "1password", ref: "GITHUB_TOKEN" }` used to
 * type-check while being nonsense for every real `op://...` reference. This
 * tagged union makes each grammar its own shape: naming a store also commits
 * to the fields that address a secret within it, and the `_tag` is the one
 * discriminator, not a sibling string.
 *
 * Field names come from each CLI's own addressing scheme, not an invented
 * generalization:
 * - `OnePassword` — `op read op://<vault>/<item>/<field>`.
 * - `Doppler` — `doppler secrets get <name> --project <project> --config <config>`.
 * - `Keychain` — `security find-generic-password -s <service> [-a <account>]`.
 * - `Pass` — `pass show <path>`, a store path like `work/github/token`.
 * - `Env` — a plain environment variable name, read from the process's own environment.
 *
 * This is a props-and-state schema break from the single `ref: Schema.String`
 * this replaced. Nothing built on the old shape has ever been deployed against
 * a real machine (see `AGENTS.md` §14 and `docs/V1-PLAN.md`), so there is no
 * persisted state anywhere that needs migrating — this is a clean break, not
 * a migration.
 */
export const SecretSource = Schema.TaggedUnion({
  OnePassword: {
    vault: Schema.String,
    item: Schema.String,
    field: Schema.String,
  },
  Doppler: {
    project: Schema.String,
    config: Schema.String,
    name: Schema.String,
  },
  Keychain: {
    service: Schema.String,
    account: Schema.optionalKey(Schema.String),
  },
  Pass: {
    path: Schema.String,
  },
  Env: {
    variable: Schema.String,
  },
});

export type SecretSource = typeof SecretSource.Type;

/** Which store a {@link SecretSource} names, without the fields that address a secret within it. */
export type SecretSourceTag = SecretSource["_tag"];

/**
 * Renders a {@link SecretSource} back into the single string a human would
 * recognize as "the reference" — the same shape backends used to receive
 * directly, now reconstructed for error messages instead of being the field
 * itself.
 */
export const describeSecretSource = (source: SecretSource): string =>
  Match.value(source).pipe(
    Match.tagsExhaustive({
      OnePassword: (s) => `op://${s.vault}/${s.item}/${s.field}`,
      Doppler: (s) => `${s.project}/${s.config}/${s.name}`,
      Keychain: (s) =>
        UndefinedOr.match(s.account, {
          onUndefined: () => s.service,
          onDefined: (account) => `${s.service}/${account}`,
        }),
      Pass: (s) => s.path,
      Env: (s) => s.variable,
    }),
  );

/** The CLI for a backend isn't installed, or isn't on PATH. */
export class SecretCliMissing extends Data.TaggedError("SecretCliMissing")<{
  source: SecretSource;
  cli: string;
  install: string;
  cause: CommandError;
}> {
  override get message() {
    return `The ${this.source._tag} CLI ("${this.cli}") is not installed or not on PATH. ${this.install}`;
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
  source: SecretSource;
  signInCommand: string;
  cause: CommandError;
}> {
  override get message() {
    return `The ${this.source._tag} CLI is not signed in. Run \`${this.signInCommand}\` yourself — machine-run deliberately never automates authentication.`;
  }
}

/**
 * The store is reachable and authenticated, but this reference didn't
 * resolve. `cause` is absent for backends that don't shell out (`env`).
 */
export class SecretReadFailed extends Data.TaggedError("SecretReadFailed")<{
  source: SecretSource;
  cause: CommandError | undefined;
}> {
  override get message() {
    return `Failed to read "${describeSecretSource(this.source)}" from ${this.source._tag}.`;
  }
}

/**
 * The store was reachable, but no entry exists at this address — as opposed
 * to being unreachable, locked, or momentarily busy. This is the one
 * {@link SecretError} member a caller may treat as licence to *create* the
 * secret it went looking for; treating any of the others that way risks
 * minting a replacement over a real secret the read merely failed to reach —
 * see `packages/state/src/DataKey.ts`'s `ensureDataKey`, the consumer this
 * case exists for.
 *
 * Only `backends/Keychain.ts`'s `classify` produces this today, matched on a
 * real, structural signal rather than message text (`AGENTS.md`
 * #11's caution against building control flow on CLI wording): `security
 * find-generic-password` for an entry that does not exist was verified on
 * this machine (macOS, 2026-08-14) to exit `44` with `security:
 * SecKeychainSearchCopyNext: The specified item could not be found in the
 * keychain.` on stderr. A *locked* keychain queried the same way does not
 * reproduce that signal — verified the same day against a disposable,
 * throwaway keychain (never the login keychain): querying it locked did not
 * exit at all inside a 120s window, instead blocking on an interactive
 * Security Agent prompt, which is exactly why every other failure must
 * propagate rather than be folded into "absent".
 */
export class SecretNotFound extends Data.TaggedError("SecretNotFound")<{
  source: SecretSource;
  cause: CommandError | undefined;
}> {
  override get message() {
    return `No entry found for "${describeSecretSource(this.source)}" in ${this.source._tag}.`;
  }
}

/**
 * The reference is not in the shape this backend accepts — caught before any
 * command runs, so it carries no `CommandError` cause.
 *
 * Most of what this used to catch is now impossible to construct at all:
 * `Doppler`'s three-part `project/config/name` string and `Keychain`'s
 * `service/account` split were parsed out of one opaque `ref` at runtime, so
 * a malformed one only failed when read. Now those are separate typed fields,
 * so there is no string left to parse and nothing left to reject. What
 * remains is a field that is still just a string whose shape the type system
 * can't constrain further — `Env`'s `variable`, which must look like a shell
 * identifier for `Config.redacted` to mean anything by it.
 */
export class SecretRefInvalid extends Data.TaggedError("SecretRefInvalid")<{
  source: SecretSource;
  expected: string;
}> {
  override get message() {
    return `"${describeSecretSource(this.source)}" is not a valid ${this.source._tag} reference. Expected ${this.expected}.`;
  }
}

export type SecretError =
  | SecretCliMissing
  | SecretAuthRequired
  | SecretReadFailed
  | SecretRefInvalid
  | SecretNotFound;

/**
 * One secret store, narrowed to the one {@link SecretSource} variant it
 * addresses secrets with. `OnePasswordBackend` only ever receives an
 * `Extract<SecretSource, { _tag: "OnePassword" }>`, never a `Doppler` or
 * `Pass` reference shaped for a different store — the compiler rejects that
 * at the call site, rather than the backend having to reject it at runtime.
 *
 * `read` returns a {@link Redacted.Redacted} rather than a bare `string`.
 * That's not decoration: Alchemy's command redactor only scrubs values it
 * knows are secret, and a bare string is one careless template literal away
 * from a `CommandError` message, a log line, or `ps` output. Making the
 * secret type-level opaque means unwrapping it is a visible, greppable act.
 */
export interface SecretBackend<S extends SecretSource> {
  readonly id: S["_tag"];
  /**
   * Resolves a backend-specific reference to its value.
   *
   * The value is returned **verbatim**. Whitespace can be significant — an
   * OpenSSH private key is rejected as malformed without its trailing
   * newline — so trimming is a decision only the consumer can make, and
   * `Machine.SecretFile` exposes it as an explicit policy.
   */
  readonly read: (source: S, exec: Exec) => Effect.Effect<Redacted.Redacted<string>, SecretError>;
}
