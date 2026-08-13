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
import type { Exec } from "../src/DataKey.ts";
import { wrapState } from "../src/EncryptedState.ts";
import type { Envelope } from "../src/Envelope.ts";

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
        return { exitCode: 0, stdout: `${value}\n`, stderr: "" };
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
    expect(JSON.stringify(stored)).not.toContain(secret);

    // And the row is still recoverable — this isn't corruption, it's encryption.
    const read = yield* state.get({ stack: "s", stage: "dev", fqn: "MyResource" });
    expect(
      Redacted.value((read as CreatedResourceState).attr.privateKey as Redacted.Redacted<string>),
    ).toBe(secret);
  }),
);

it.effect("a modified ciphertext fails to decrypt: get degrades to undefined, not a throw", () =>
  Effect.gen(function* () {
    const { service: underlying, rows } = makeFakeUnderlying();
    const { exec } = makeFakeKeychain();
    const state = yield* wrapState(underlying, exec, crypto);

    yield* state.set({ stack: "s", stage: "dev", fqn: "MyResource", value: row() });

    const stored = rows.get("s/dev/MyResource") as Envelope;
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
