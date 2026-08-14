import { NodeCrypto } from "@effect/platform-node";
import { silentSession } from "@machine-run/core";
import { CommandExecutor, CommandExecutorLive } from "alchemy/Command";
import {
  encodeState,
  reviveState,
  State,
  StateStoreError,
  makeLocalState,
  type PersistedState,
  type ReplacedResourceState,
  type StateService,
} from "alchemy/State";
import * as Cache from "effect/Cache";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { ensureDataKey, readDataKey, type Exec } from "./DataKey.ts";
import { additionalData, decrypt, encrypt, Envelope } from "./Envelope.ts";

/**
 * A `StateService` that wraps Alchemy's `LocalState`, encrypting each row's
 * value on `set` and decrypting it on `get`.
 *
 * ## Threat model
 *
 * This protects **disk-at-rest reads only**: a stolen laptop, a synced
 * backup, a `.alchemy/` directory accidentally committed or uploaded. It does
 * **not** protect against anything running as the user on this machine —
 * that process can ask the keychain for the same key this store does, the
 * same way it could read `~/.ssh/id_ed25519` directly. Claiming more than
 * that would be theatre. See `docs/CONCEPTS.md`'s "`Redacted` does not
 * protect state at rest" for the finding that motivates this, and
 * `docs/TASKS.md`'s "`Machine.EncryptedState`" for the full spec.
 *
 * ## Why this exists at all
 *
 * `Machine.SecretFile`'s state is `{path, mode}` and carries no secret
 * material — that rule is not weakened by this store existing. What lands in
 * state regardless: Alchemy's own `KeyPair`-shaped resources persist
 * `Redacted<string>` private-key material, which `State/StateEncoding.ts`
 * writes to disk as the literal string (`Redacted` redacts *printing*, not
 * *persistence* — see the CONCEPTS.md note above); and any cloud resource a
 * stack also manages (the entire point of it being an Alchemy stack) commonly
 * persists an API token as an attribute. This store is defence in depth for
 * that unavoidable material, not a licence to start storing secrets on
 * purpose.
 *
 * ## Envelope
 *
 * One data key per **stack** (not per stage), AES-256-GCM, generated on first
 * `set` and stored in the OS keychain via `@machine-run/secrets`'s `keychain`
 * backend — see `DataKey.ts`. Every row's ciphertext is bound to its stack,
 * stage and fqn as GCM additional authenticated data (`Envelope.ts`), so a
 * row copied to a different resource, stage or stack fails to decrypt instead
 * of silently applying to the wrong thing.
 *
 * ## Losing the key
 *
 * State is not the source of truth — the machine is. `get` degrades a row
 * that fails to decrypt (missing key, corrupt ciphertext, tampering, or a row
 * moved to a different identity) to `undefined` — indistinguishable from
 * "nothing recorded" — logging a warning so the degradation is never silent.
 * The existing `read` → `AdoptPolicy` path (`packages/engine/src/toProvider.ts`)
 * then re-adopts whatever is really on the machine. A hard failure here would
 * brick every future deploy over one lost keychain entry.
 *
 * `set` does **not** get the same treatment: if no key can be obtained or
 * created for a stack, nothing has been lost yet (nothing was ever encrypted
 * under the key that failed to materialise), so this surfaces as an ordinary
 * `StateStoreError` — the same failure class `LocalState.ts` itself uses for
 * a disk write that fails — rather than silently writing plaintext or
 * silently dropping the write.
 *
 * ## What is out of scope
 *
 * `getOutput`/`setOutput` (Alchemy's cross-stack reference mechanism) pass
 * through to the wrapped `LocalState` **unencrypted**. This repo has no
 * multi-stack usage yet (`docs/CONCEPTS.md`'s `Namespace` note: "a stack
 * manages one machine"), so this was not one of this task's five sub-tasks
 * and is not exercised by anything today. Encrypting it later is a small,
 * mechanical extension of the same `encrypt`/`decrypt` helpers in
 * `Envelope.ts`, once a recipe actually returns a secret-shaped stack output.
 */
export const encryptedState = () =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      const context = yield* Effect.context<
        FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
      >();
      const make = makeEncryptedState.pipe(
        Effect.provide(CommandExecutorLive()),
        Effect.provide(NodeCrypto.layer),
        Effect.provideContext(context),
      );
      // `State`'s own service type is `Effect.Effect<StateService>`, not a
      // bare `StateService` — Alchemy resolves it with a double `yield*`
      // (`Apply.ts`: `yield* yield* State`). `Effect.cached` is what
      // `LocalState.localState()` uses for exactly this shape, so the
      // (comparatively expensive: it also builds a `CommandExecutor` and
      // resolves `Crypto`) construction below runs once per process no
      // matter how many times something looks up `State`.
      return yield* Effect.cached(make);
    }),
  );

/** Row-shaped failure, folded into a single degrade-and-log path by `get`. */
class RowUnreadable extends Data.TaggedError("RowUnreadable")<{
  stack: string;
  stage: string;
  fqn: string;
  cause: unknown;
}> {}

type CryptoService = typeof Crypto.Crypto.Service;

/**
 * Builds the encrypting `StateService` around an already-built underlying
 * one, plus the already-resolved `exec`/`crypto` its key management needs.
 *
 * Split out from {@link makeEncryptedState} so the encrypt/decrypt wrapping
 * logic — the actual feature — is testable against a small in-memory fake
 * `StateService` and a fake `Exec`, with no `FileSystem`/`Path`/
 * `CommandExecutor`/`Crypto` context and no real disk I/O at all. Testing
 * against the real `LocalState` would additionally hit the fact that its
 * `.alchemy/state` root is captured from `process.cwd()` once at module load
 * (`LocalState.ts`'s `initialCwd`), which a per-test temp directory cannot
 * redirect — one more reason to keep this module's own tests decoupled from
 * `LocalState` entirely, matching AGENTS.md #6: state persistence itself
 * "isn't ours to test — that's Alchemy's."
 */
export const wrapState = (
  underlying: StateService,
  exec: Exec,
  crypto: CryptoService,
): Effect.Effect<StateService> =>
  Effect.gen(function* () {
    const local = underlying;

    // Deduplicates concurrent `set`s for a stack with no key yet (see
    // `DataKey.ts`'s `ensureDataKey`) and avoids re-shelling to `security` on
    // every write. A short TTL, rather than none, lets a transient failure
    // (e.g. a momentarily locked keychain) be retried within one run instead
    // of wedging every subsequent `set` for the rest of it — nothing unsafe
    // about retrying, since a failed attempt never persists or uses a key.
    const dataKeys = yield* Cache.make({
      capacity: 64,
      timeToLive: "30 seconds",
      lookup: (stack: string) => ensureDataKey(stack, exec, crypto),
    });

    // `local.set` is generic over `V extends PersistedState`, but the row
    // this store physically writes is the envelope, never the caller's
    // `value` itself — that is the entire feature. `LocalState.set` only
    // serialises whatever it is given (`encodeState` + `JSON.stringify`) and
    // hands it straight back, so this is the one place the type says
    // `PersistedState` while the disk holds something else on purpose. Two
    // independent assertions (each through `unknown`, in their own
    // statement) rather than one chained `as unknown as X`: chaining both in
    // a single expression is exactly what `noChainedTypeAssertions` exists to
    // flag, since it discards the ability to reason about either step alone.
    const localSetUntyped: unknown = local.set;
    // The disk deliberately holds an `Envelope` where the interface says
    // `PersistedState` — see the comment above for why.
    // oxlint-disable-next-line effect/noAs
    const setEnvelope = localSetUntyped as (request: {
      stack: string;
      stage: string;
      fqn: string;
      value: Envelope;
    }) => Effect.Effect<Envelope, StateStoreError, never>;

    const decodeRow = (
      raw: PersistedState,
      request: { stack: string; stage: string; fqn: string },
    ): Effect.Effect<PersistedState, RowUnreadable> =>
      Effect.gen(function* () {
        const envelope = yield* Schema.decodeUnknownEffect(Envelope)(raw).pipe(
          Effect.catch((cause) => Effect.fail(new RowUnreadable({ ...request, cause }))),
        );
        // Read-only: never generates a key. See `DataKey.ts`'s `readDataKey`.
        const key = yield* readDataKey(request.stack, exec).pipe(
          Effect.catch((cause) => Effect.fail(new RowUnreadable({ ...request, cause }))),
        );
        const plaintext = yield* decrypt(
          key,
          additionalData(request.stack, request.stage, request.fqn),
          envelope,
        ).pipe(Effect.catch((cause) => Effect.fail(new RowUnreadable({ ...request, cause }))));
        // Reproducing Alchemy's own on-disk wire format exactly:
        // `LocalState.ts` revives a row with `JSON.parse(contents,
        // reviveState)`, where `reviveState` rebuilds Alchemy's private
        // `Redacted`/`Duration`/`Date` markers (`alchemy/State/StateEncoding.ts`).
        // Schema's JSON codecs cannot express a third-party reviver, so this
        // is the one place a state-store adapter is expected to reach for the
        // global directly — see the rule's own message ("platform adapters
        // may disable this rule explicitly").
        // A third-party reviver is the only thing that can rebuild these
        // markers, and it is typed `any`, so its result has to be asserted once.
        // oxlint-disable-next-line effect/noGlobals, effect/noAs
        return JSON.parse(new TextDecoder().decode(plaintext), reviveState) as PersistedState;
      });

    const get: StateService["get"] = (request) =>
      Effect.gen(function* () {
        const raw = yield* local.get(request);
        if (raw === undefined) return undefined;
        return yield* decodeRow(raw, request);
      }).pipe(
        Effect.catchTag("RowUnreadable", (error) =>
          Effect.logWarning(
            `machine-run could not decrypt state for "${request.fqn}" in stack "${request.stack}" ` +
              `stage "${request.stage}" (${String(error.cause)}); treating it as absent so it will ` +
              `be re-adopted from the machine.`,
          ).pipe(Effect.as(undefined)),
        ),
      );

    const set: StateService["set"] = (request) =>
      Effect.gen(function* () {
        const key = yield* Cache.get(dataKeys, request.stack).pipe(
          Effect.catch((cause) =>
            Effect.fail(
              new StateStoreError({
                message: `cannot obtain a state-encryption key for stack "${request.stack}": ${cause.message}`,
                cause,
              }),
            ),
          ),
        );
        // Matching Alchemy's own `JSON.stringify(encodeState(request.value),
        // null, 2)` (`LocalState.ts`) exactly, so what this store encrypts is
        // byte-for-byte what an unencrypted `localState()` would have
        // written. See `decodeRow`'s matching disable for the full reasoning.
        // oxlint-disable-next-line effect/noGlobals -- see comment above
        const plaintext = new TextEncoder().encode(JSON.stringify(encodeState(request.value)));
        const envelope = yield* encrypt(
          key,
          additionalData(request.stack, request.stage, request.fqn),
          plaintext,
          crypto.randomBytes,
        ).pipe(
          Effect.catch((cause) =>
            Effect.fail(new StateStoreError({ message: "failed to encrypt a state row", cause })),
          ),
        );
        yield* setEnvelope({
          stack: request.stack,
          stage: request.stage,
          fqn: request.fqn,
          value: envelope,
        });
        return request.value;
      });

    const state: StateService = {
      id: "encrypted-local",
      getVersion: () => local.getVersion(),
      listStacks: () => local.listStacks(),
      listStages: (stack) => local.listStages(stack),
      list: (request) => local.list(request),
      delete: (request) => local.delete(request),
      deleteStack: (request) => local.deleteStack(request),
      // See this module's doc comment: out of scope, passed through as-is.
      getOutput: (request) => local.getOutput(request),
      setOutput: (request) => local.setOutput(request),
      get,
      set,
      // Reimplemented rather than delegated: `LocalState`'s own
      // `getReplacedResources` calls *its own* `get`, which would read back
      // the raw envelope (no `resourceType`/`status`/… fields at all) and so
      // never find a `"replaced"` row. Going through this store's own
      // decrypting `get` (referenced via `state`, not `local`) is what makes
      // replacement cleanup see real rows again.
      getReplacedResources: (request) =>
        Effect.gen(function* () {
          const fqns = yield* state.list(request);
          const rows = yield* Effect.all(fqns.map((fqn) => state.get({ ...request, fqn })));
          return rows.filter((row): row is ReplacedResourceState => row?.status === "replaced");
        }),
    };
    return state;
  });

/**
 * Wires the real world into {@link wrapState}: Alchemy's `LocalState` as the
 * underlying store, a `CommandExecutor` built for this call (bound to the
 * engine's silent, non-reporting session — see below), and Effect's `Crypto`
 * service.
 */
export const makeEncryptedState: Effect.Effect<
  StateService,
  never,
  FileSystem.FileSystem | Path.Path | CommandExecutor | Crypto.Crypto
> = Effect.gen(function* () {
  const local = yield* makeLocalState();
  const executor = yield* CommandExecutor;
  const crypto = yield* Crypto.Crypto;

  // Keychain reads/writes here are bookkeeping for the state store itself,
  // not a reconciler observing or changing the machine — there is no plan or
  // apply session to attach their output to, so the same silent, dropping
  // session the engine binds for `diff`/`read` (`packages/core/src/Sessions.ts`)
  // is the right one to reuse rather than inventing a second one.
  const exec: Exec = (props) => executor.run(props, silentSession);

  return yield* wrapState(local, exec, crypto);
});
