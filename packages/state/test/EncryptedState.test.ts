import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { CommandError, UnexpectedExit } from "alchemy/Command";
import {
  type CreatedResourceState,
  type PersistedState,
  type ReplacedResourceState,
  type StateService,
} from "alchemy/State";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Exec } from "../src/DataKey.ts";
import { wrapState } from "../src/EncryptedState.ts";
import { Envelope } from "../src/Envelope.ts";

/**
 * Renders an arbitrary stored row as JSON text for a substring check —
 * `Schema.Json` codecs rather than `JSON.stringify`. `decodeUnknownSync`
 * parses the boundary (a row genuinely is `unknown` here, read back out of a
 * fake in-memory store) before `encodeSync` serializes it.
 */
const toJsonText = (value: unknown): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Json))(Schema.decodeUnknownSync(Schema.Json)(value));

/** Narrows a read-back `PersistedState` to the `"created"` case a test expects it to be. */
const isCreatedResourceState = (
  state: PersistedState | undefined,
): state is CreatedResourceState => state !== undefined && "status" in state && state.status === "created";

/**
 * A tiny in-memory `StateService`, standing in for `LocalState`.
 *
 * `wrapState` is tested against this rather than the real `LocalState`
 * because `LocalState.ts` anchors its `.alchemy/state` root to
 * `process.cwd()` captured once at module load, which a per-test temp
 * directory can't redirect — and because state persistence itself isn't this
 * package's job to re-verify (AGENTS.md #6: "That's Alchemy's"). `rows` is
 * exposed directly so a test can inspect or corrupt the raw stored value —
 * standing in for opening the `.json` file `LocalState` would have written.
 */
const makeFakeUnderlying = () => {
  const rows = new Map<string, unknown>();
  const key = (r: { stack: string; stage: string; fqn: string }) =>
    `${r.stack}/${r.stage}/${r.fqn}`;

  const service: StateService = {
    id: "fake-underlying",
    getVersion: () => Effect.succeed(1),
    listStacks: () => Effect.succeed([]),
    listStages: () => Effect.succeed([]),
    list: (request) => {
      const prefix = `${request.stack}/${request.stage}/`;
      return Effect.succeed(
        [...rows.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)),
      );
    },
    // `StateService.get` promises `PersistedState`, but `wrapState` (the thing
    // under test) stores an `Envelope` in this same slot instead — a real
    // boundary mismatch between what the interface declares and what this
    // fake actually holds once encryption is in the loop, not a convenience.
    // oxlint-disable-next-line effect/noAs -- see comment above; `rows` is genuinely untyped storage.
    get: (request) => Effect.succeed(rows.get(key(request)) as PersistedState | undefined),
    set: (request) =>
      Effect.sync(() => {
        rows.set(key(request), request.value);
        return request.value;
      }),
    delete: (request) =>
      Effect.sync(() => {
        rows.delete(key(request));
      }),
    deleteStack: () => Effect.void,
    getReplacedResources: () => Effect.succeed([]),
    getOutput: () => Effect.succeed(undefined),
    setOutput: (request) => Effect.succeed(request.value),
  };

  return { service, rows };
};

/**
 * A fake `Exec` simulating the two `security` subcommands `DataKey.ts` runs,
 * backed by an in-memory map instead of the real keychain. Command strings
 * are parsed just enough to recognise `-s`/`-a` — real values here are always
 * simple identifiers (see `Sh.sh`'s `SAFE` alphabet), so a whitespace split
 * is enough; a real shell's quoting rules are not under test here.
 */
const makeFakeKeychain = () => {
  const entries = new Map<string, string>();

  const flag = (tokens: string[], name: string): string | undefined => {
    const i = tokens.indexOf(name);
    return i === -1 ? undefined : tokens[i + 1];
  };

  const exec: Exec = (props) =>
    Effect.gen(function* () {
      const tokens = props.command.split(/\s+/);
      const subcommand = tokens[1];
      const service = flag(tokens, "-s");
      const account = flag(tokens, "-a");
      const entryKey = `${service}/${account}`;

      if (subcommand === "find-generic-password") {
        const value = entries.get(entryKey);
        if (value === undefined) {
          return yield* Effect.fail(
            new CommandError({
              command: props.command,
              reason: new UnexpectedExit({
                exitCode: 44,
                stderr:
                  "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
              }),
            }),
          );
        }
        // `-g`, not `-w`: the real backend switched because `-w` silently
        // returns the ASCII-hex encoding of any value it considers
        // unprintable, which is every multi-line secret. `-g` puts the
        // password line on stderr and the printable form in quotes.
        return { exitCode: 0, stdout: "", stderr: `password: "${value}"\n` };
      }

      if (subcommand === "add-generic-password") {
        const fromEnv = props.env?.MACHINE_RUN_STATE_KEY;
        const value =
          fromEnv === undefined
            ? undefined
            : Redacted.isRedacted(fromEnv)
              ? Redacted.value(fromEnv)
              : fromEnv;
        if (value === undefined) {
          return yield* Effect.die(
            "test fake: add-generic-password called without MACHINE_RUN_STATE_KEY in env",
          );
        }
        entries.set(entryKey, value);
        return { exitCode: 0, stdout: "", stderr: "" };
      }

      return yield* Effect.die(`test fake: unrecognised command "${props.command}"`);
    });

  return { exec, entries };
};

/**
 * Wraps a fake keychain's `exec` so `find-generic-password` always fails with
 * a failure that is *not* the verified "no such entry" signal
 * (`backends/Keychain.ts`'s `isNoSuchKeychainItem`: exit `44` and a stderr
 * containing "could not be found in the keychain") — standing in for a
 * locked keychain, "user interaction is not allowed", or `security` being
 * momentarily busy. The exact wording here is not a captured fixture (a real
 * locked keychain blocks on an interactive prompt rather than printing
 * anything — see that file's doc comment); what matters for this test is
 * only that it is *some* failure distinct from the not-found one.
 * `add-generic-password` still writes through to the same fake keychain's
 * `entries`, so a wrongly-minted key would be visible there.
 */
const withUnreadableFind =
  (keychain: ReturnType<typeof makeFakeKeychain>): Exec =>
  (props) => {
    const subcommand = props.command.split(/\s+/)[1];
    if (subcommand === "find-generic-password") {
      return Effect.fail(
        new CommandError({
          command: props.command,
          reason: new UnexpectedExit({
            exitCode: 1,
            stderr: "security: SecKeychainSearchCopyNext: could not access the keychain.",
          }),
        }),
      );
    }
    return keychain.exec(props);
  };

/** Resolved once: the real Node `Crypto` service. */
const crypto = Effect.runSync(Crypto.Crypto.pipe(Effect.provide(NodeCrypto.layer)));

const row = (overrides: Partial<CreatedResourceState> = {}): CreatedResourceState => ({
  resourceType: "Machine.Fake",
  namespace: undefined,
  fqn: "MyResource",
  logicalId: "MyResource",
  instanceId: "instance-1",
  providerVersion: 1,
  status: "created",
  downstream: [],
  bindings: [],
  props: { name: "MyResource" },
  attr: { region: "us-east-1" },
  ...overrides,
});

it.effect("round-trips a row through set then get", () =>
  Effect.gen(function* () {
    const { service: underlying } = makeFakeUnderlying();
    const { exec } = makeFakeKeychain();
    const state = yield* wrapState(underlying, exec, crypto);

    const value = row();
    const written = yield* state.set({ stack: "s", stage: "dev", fqn: "MyResource", value });
    expect(written).toEqual(value);

    const read = yield* state.get({ stack: "s", stage: "dev", fqn: "MyResource" });
    expect(read).toEqual(value);
  }),
);

/**
 * This is the test that actually proves the feature: whatever `set` hands to
 * the underlying store must not contain the plaintext of a secret-shaped
 * value — the scenario `docs/TASKS.md` motivates this with, an Alchemy
 * `KeyPair`-shaped `Redacted<string>` landing in `attr`.
 */
it.effect("the plaintext secret does not appear in what gets written to the underlying store", () =>
  Effect.gen(function* () {
    const { service: underlying, rows } = makeFakeUnderlying();
    const { exec } = makeFakeKeychain();
    const state = yield* wrapState(underlying, exec, crypto);

    const secret = "AKIAABCDEFGHIJKLMNOP-do-not-persist-me";
    const value = row({ attr: { privateKey: Redacted.make(secret) } });

    yield* state.set({ stack: "s", stage: "dev", fqn: "MyResource", value });

    const stored = rows.get("s/dev/MyResource");
    expect(toJsonText(stored)).not.toContain(secret);

    // And the row is still recoverable — this isn't corruption, it's encryption.
    const read = yield* state.get({ stack: "s", stage: "dev", fqn: "MyResource" });
    const created = Result.getOrThrow(
      Result.liftPredicate(read, isCreatedResourceState, () => "expected a CreatedResourceState"),
    );
    expect(Redacted.value(created.attr.privateKey)).toBe(secret);
  }),
);

it.effect("a modified ciphertext fails to decrypt: get degrades to undefined, not a throw", () =>
  Effect.gen(function* () {
    const { service: underlying, rows } = makeFakeUnderlying();
    const { exec } = makeFakeKeychain();
    const state = yield* wrapState(underlying, exec, crypto);

    yield* state.set({ stack: "s", stage: "dev", fqn: "MyResource", value: row() });

    const stored = Schema.decodeUnknownSync(Envelope)(rows.get("s/dev/MyResource"));
    const tampered = {
      ...stored,
      ciphertext: `${stored.ciphertext.slice(0, -1)}${stored.ciphertext.at(-1) === "A" ? "B" : "A"}`,
    };
    rows.set("s/dev/MyResource", tampered);

    const read = yield* state.get({ stack: "s", stage: "dev", fqn: "MyResource" });
    expect(read).toBeUndefined();
  }),
);

it.effect(
  "a row moved to a different fqn fails to decrypt rather than being read as the wrong resource",
  () =>
    Effect.gen(function* () {
      const { service: underlying, rows } = makeFakeUnderlying();
      const { exec } = makeFakeKeychain();
      const state = yield* wrapState(underlying, exec, crypto);

      yield* state.set({
        stack: "s",
        stage: "dev",
        fqn: "ResourceA",
        value: row({ fqn: "ResourceA" }),
      });

      // Simulate a row physically relocated to a different resource's key —
      // e.g. a bug, or a hand-edited state file — without re-encrypting it.
      rows.set("s/dev/ResourceB", rows.get("s/dev/ResourceA"));

      const read = yield* state.get({ stack: "s", stage: "dev", fqn: "ResourceB" });
      expect(read).toBeUndefined();
    }),
);

it.effect(
  "a lost keychain entry degrades an existing row to absent instead of failing the run",
  () =>
    Effect.gen(function* () {
      const { service: underlying } = makeFakeUnderlying();
      const { exec, entries } = makeFakeKeychain();
      const state = yield* wrapState(underlying, exec, crypto);

      yield* state.set({ stack: "s", stage: "dev", fqn: "MyResource", value: row() });
      expect(entries.size).toBe(1);

      // The keychain entry is gone — a user ran `security delete-generic-password`,
      // migrated to a new machine without exporting the keychain, or similar.
      entries.clear();

      const read = yield* state.get({ stack: "s", stage: "dev", fqn: "MyResource" });
      expect(read).toBeUndefined();
    }),
);

/**
 * The bug `MUST_CLEANUP.md` 0.1 describes: `ensureDataKey` used to catch
 * *every* `readDataKey` failure, not just a genuine "no key yet", and
 * respond by minting and persisting a fresh key. A transient read failure —
 * the entry is still there, `security` just couldn't read it right now —
 * would therefore overwrite the real key and permanently orphan every row
 * already encrypted under it. This is deliberately not the "entry deleted"
 * scenario above (that one has no real key to lose); it is the strictly
 * worse case where a real key exists and gets clobbered anyway.
 */
it.effect(
  "a read failure while the keychain entry still exists must not mint a replacement key",
  () =>
    Effect.gen(function* () {
      const { service: underlying } = makeFakeUnderlying();
      const keychain = makeFakeKeychain();
      const state1 = yield* wrapState(underlying, keychain.exec, crypto);

      // First write mints the real key and encrypts "Existing" under it.
      yield* state1.set({
        stack: "s",
        stage: "dev",
        fqn: "Existing",
        value: row({ fqn: "Existing" }),
      });
      expect(keychain.entries.size).toBe(1);

      // A later run — a fresh `wrapState`/`Cache`, standing in for a new
      // process picking up where the last one left off — hits a `security`
      // failure that is not the verified "not found" signal: the entry is
      // still there, this read just doesn't work right now.
      const state2 = yield* wrapState(underlying, withUnreadableFind(keychain), crypto);

      // Before the fix this succeeds (wrongly). `Effect.flip` turns an
      // effect that is expected to fail into one whose success *is* that
      // failure value — so if `set` unexpectedly succeeds here, this line
      // itself fails the test, rather than silently letting a wrong "it
      // worked" through.
      const failure = yield* state2
        .set({ stack: "s", stage: "dev", fqn: "New", value: row({ fqn: "New" }) })
        .pipe(Effect.flip);
      expect(failure._tag).toBe("StateStoreError");

      // The keychain entry must be untouched: no replacement key minted and
      // persisted over the real one.
      expect(keychain.entries.size).toBe(1);

      // And critically, the row encrypted before the flaky read is still
      // decryptable through a working exec afterward — nothing was lost.
      // Before the fix, the wrongly-minted key would have been persisted
      // over the real one, and this would degrade to `undefined` exactly
      // like the genuinely-deleted-entry case above, indistinguishable from
      // it even though the entry was never actually gone.
      const state3 = yield* wrapState(underlying, keychain.exec, crypto);
      const recovered = yield* state3.get({ stack: "s", stage: "dev", fqn: "Existing" });
      expect(recovered).toEqual(row({ fqn: "Existing" }));
    }),
);

it.effect("getReplacedResources finds a replaced row through this store's own decryption", () =>
  Effect.gen(function* () {
    const { service: underlying } = makeFakeUnderlying();
    const { exec } = makeFakeKeychain();
    const state = yield* wrapState(underlying, exec, crypto);

    const replaced: ReplacedResourceState = {
      ...row({ fqn: "Old" }),
      status: "replaced",
      old: row({ fqn: "Old" }),
      deleteFirst: false,
    };

    yield* state.set({ stack: "s", stage: "dev", fqn: "Old", value: replaced });
    yield* state.set({ stack: "s", stage: "dev", fqn: "New", value: row({ fqn: "New" }) });

    const found = yield* state.getReplacedResources({ stack: "s", stage: "dev" });
    expect(found).toHaveLength(1);
    expect(found[0]?.fqn).toBe("Old");
  }),
);
