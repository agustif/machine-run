import { MachinePathsLive, silentSession, PlatformLive } from "@machine-run/core";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { CommandExecutor, CommandExecutorLive, type CommandRunProps } from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import {
  KeyPairIncomplete,
  makeKeyReconciler,
  parseFingerprint,
  parsePublicKey,
  type KeyProps,
} from "../src/Key.ts";

// ---------------------------------------------------------------------------
// Pure parsing.
// ---------------------------------------------------------------------------

it("parsePublicKey reads type and comment from a real OpenSSH public key line", () => {
  // Captured verbatim from `ssh-keygen -t ed25519 -f id_test -C "test-comment" -N ""`.
  const line =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMBPRMl3j36RIng7sMf+ciTKq/tHYZczpAuCtgyOoq5j test-comment\n";
  expect(parsePublicKey(line)).toEqual({ keyType: "ssh-ed25519", comment: "test-comment" });
});

it('parsePublicKey keeps a multi-word comment intact (`ssh-keygen -C "work laptop"` is legal)', () => {
  const line = "ssh-ed25519 AAAAsomekeymaterial work laptop";
  expect(parsePublicKey(line)).toEqual({ keyType: "ssh-ed25519", comment: "work laptop" });
});

it("parsePublicKey reports an empty comment, not `undefined`, when none was given", () => {
  // Captured verbatim from `ssh-keygen -t ed25519 -f id_nocomment -C "" -N ""`.
  const line =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIZG0KpN23EMluPT5TxShl42ZjJhVAsXw/Nk65xesWPe \n";
  expect(parsePublicKey(line)).toEqual({ keyType: "ssh-ed25519", comment: "" });
});

it("parsePublicKey rejects a line with no key material at all", () => {
  expect(parsePublicKey("ssh-ed25519")).toBeUndefined();
  expect(parsePublicKey("")).toBeUndefined();
});

it("parseFingerprint reads the SHA256 field from real `ssh-keygen -lf` output", () => {
  // Captured verbatim from `ssh-keygen -lf id_test.pub`.
  const output = "256 SHA256:pxiH72Fxf2aHIOr/FB5eC/dwbavL1FeTz2RQq67k8sI test-comment (ED25519)\n";
  expect(parseFingerprint(output)).toBe("SHA256:pxiH72Fxf2aHIOr/FB5eC/dwbavL1FeTz2RQq67k8sI");
});

it('parseFingerprint is not fooled by a comment that itself contains the text "SHA256:"', () => {
  const output = "256 SHA256:realhash my SHA256: fake comment (ED25519)";
  expect(parseFingerprint(output)).toBe("SHA256:realhash");
});

it("parseFingerprint reports undefined for output with no SHA256 field where expected", () => {
  expect(parseFingerprint("not a real ssh-keygen line")).toBeUndefined();
  expect(parseFingerprint("")).toBeUndefined();
});

// ---------------------------------------------------------------------------
// The reconciler, against a real temp directory and a real `ssh-keygen` —
// verified present and working on this machine; see `Key.ts`'s doc comment
// for the exact commands this suite's design leans on (the overwrite prompt
// exiting 1 on closed stdin, `-b` being ignored for ed25519, the `a@host`
// default comment).
// ---------------------------------------------------------------------------

const layer = Layer.mergeAll(MachinePathsLive(), PlatformLive(), CommandExecutorLive()).pipe(
  Layer.provideMerge(NodeServices.layer),
);

/** The real executor, wired the way `toProvider` wires it for apply/observe. */
const ctx = Effect.gen(function* () {
  const executor = yield* CommandExecutor;
  return {
    exec: (props: CommandRunProps) => executor.run(props, silentSession),
    snapshot: () => Effect.succeed(undefined),
  };
});

/** Records every command run through it while still executing it for real. */
const spyCtx = Effect.gen(function* () {
  const executor = yield* CommandExecutor;
  const seen: string[] = [];
  return {
    seen,
    exec: (props: CommandRunProps) => {
      seen.push(props.command);
      return executor.run(props, silentSession);
    },
    snapshot: () => Effect.succeed(undefined),
  };
});

const propsFor = (path: string, overrides: Partial<KeyProps> = {}): KeyProps => ({
  path,
  ...overrides,
});

it.effect("observe reports absent for a path with no key at all yet", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeKeyReconciler;
    const c = yield* ctx;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "id_ed25519");

    expect(Option.isNone(yield* reconciler.observe(propsFor(target), c))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "apply generates a real ed25519 keypair: correct modes, wire type, comment and a SHA256 fingerprint",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeKeyReconciler;
      const c = yield* ctx;
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = path.join(dir, "id_ed25519");

      const props = propsFor(target, { comment: "test-comment" });
      const desired = yield* reconciler.desired(props);
      const result = yield* reconciler.apply({ props, observed: Option.none(), desired }, c);

      expect(result.path).toBe(target);
      expect(result.publicKeyPath).toBe(`${target}.pub`);
      expect(result.publicKeyType).toBe("ssh-ed25519");
      expect(result.comment).toBe("test-comment");
      expect(result.fingerprint).toMatch(/^SHA256:/);

      const privateInfo = yield* fs.stat(target);
      expect(Number(privateInfo.mode) & 0o777).toBe(0o600);
      const publicInfo = yield* fs.stat(`${target}.pub`);
      expect(Number(publicInfo.mode) & 0o777).toBe(0o644);

      const privateContent = yield* fs.readFileString(target);
      expect(privateContent).toContain("BEGIN OPENSSH PRIVATE KEY");

      // observe now agrees with what apply just reported.
      const observed = yield* reconciler.observe(props, c);
      expect(observed).toEqual(Option.some(result));
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect('apply defaults the comment to "" rather than OpenSSH\'s own <user>@<host> default', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeKeyReconciler;
    const c = yield* ctx;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "id_ed25519");

    const props = propsFor(target);
    const desired = yield* reconciler.desired(props);
    const result = yield* reconciler.apply({ props, observed: Option.none(), desired }, c);

    expect(result.comment).toBe("");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("creates the containing directory at 0o700", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeKeyReconciler;
    const c = yield* ctx;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, ".ssh", "id_ed25519");

    const props = propsFor(target);
    const desired = yield* reconciler.desired(props);
    yield* reconciler.apply({ props, observed: Option.none(), desired }, c);

    const info = yield* fs.stat(path.dirname(target));
    expect(Number(info.mode) & 0o777).toBe(0o700);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("`-b` is passed for rsa but never for ed25519, which OpenSSH ignores it for", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeKeyReconciler;
    const spy = yield* spyCtx;
    const dir = yield* fs.makeTempDirectoryScoped();

    const ed25519Target = path.join(dir, "id_ed25519");
    const ed25519Props = propsFor(ed25519Target, { algorithm: "ed25519", bits: 256 });
    const ed25519Desired = yield* reconciler.desired(ed25519Props);
    yield* reconciler.apply(
      { props: ed25519Props, observed: Option.none(), desired: ed25519Desired },
      spy,
    );
    expect(spy.seen.some((cmd) => cmd.includes("-t") && cmd.includes("ed25519"))).toBe(true);
    expect(spy.seen.some((cmd) => cmd.includes("-b"))).toBe(false);

    const rsaTarget = path.join(dir, "id_rsa");
    const rsaProps = propsFor(rsaTarget, { algorithm: "rsa", bits: 2048 });
    const rsaDesired = yield* reconciler.desired(rsaProps);
    const rsaResult = yield* reconciler.apply(
      { props: rsaProps, observed: Option.none(), desired: rsaDesired },
      spy,
    );
    expect(spy.seen.some((cmd) => cmd.includes("-b") && cmd.includes("2048"))).toBe(true);
    expect(rsaResult.publicKeyType).toBe("ssh-rsa");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "observe raises KeyPairIncomplete for a lone private key with no .pub — never guesses",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeKeyReconciler;
      const c = yield* ctx;
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = path.join(dir, "id_ed25519");

      yield* fs.writeFileString(target, "not a real key, just occupying the path");

      const error = yield* reconciler.observe(propsFor(target), c).pipe(Effect.flip);
      expect(error).toBeInstanceOf(KeyPairIncomplete);
      if (error instanceof KeyPairIncomplete) {
        expect(error.missing).toBe("public");
      }
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("observe raises KeyPairIncomplete for a lone .pub with no private key", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeKeyReconciler;
    const c = yield* ctx;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "id_ed25519");

    yield* fs.writeFileString(`${target}.pub`, "ssh-ed25519 AAAAsomekey orphaned");

    const error = yield* reconciler.observe(propsFor(target), c).pipe(Effect.flip);
    expect(error).toBeInstanceOf(KeyPairIncomplete);
    if (error instanceof KeyPairIncomplete) {
      expect(error.missing).toBe("private");
    }
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("drift is unconditionally empty, agreeing with matches' unconditional true", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeKeyReconciler;
    const props = propsFor("/tmp/irrelevant");
    const desired = yield* reconciler.desired(props);
    const observedLikeState = {
      path: desired.path,
      publicKeyPath: desired.publicKeyPath,
      publicKeyType: "ssh-rsa",
      comment: "whatever is already there",
      fingerprint: "SHA256:whatever",
    };
    expect(reconciler.matches(observedLikeState, desired)).toBe(true);
    expect(reconciler.drift?.(observedLikeState, desired)).toEqual([]);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "drift never contains anything derived from the private key — it never reports any field at all",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeKeyReconciler;
      const c = yield* ctx;
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = path.join(dir, "id_ed25519");

      const props = propsFor(target, { comment: "test-comment" });
      const desired = yield* reconciler.desired(props);
      const generated = yield* reconciler.apply({ props, observed: Option.none(), desired }, c);
      const observed = yield* reconciler.observe(props, c);
      expect(Option.isSome(observed)).toBe(true);

      // Two shapes `drift` could ever be called with: the real observed state
      // against `desired`, and against a `desired` whose props deliberately
      // disagree with what's on disk (the only other input `toProvider.diff`
      // could ever pass) — proving the private key never surfaces regardless
      // of which comparison is made, not just that it happens not to today.
      const againstDesired = reconciler.drift?.(Option.getOrThrow(observed), desired) ?? [];
      const againstDifferentProps = reconciler.drift?.(
        Option.getOrThrow(observed),
        yield* reconciler.desired(propsFor(target, { algorithm: "rsa", comment: "different" })),
      ) ?? [];

      for (const fields of [againstDesired, againstDifferentProps]) {
        expect(fields).toEqual([]);
      }
      // Sanity: the private key really was written, so an empty `drift` here
      // is a guarantee, not an accident of nothing existing to leak.
      const privateContent = yield* fs.readFileString(generated.path);
      expect(privateContent).toContain("BEGIN OPENSSH PRIVATE KEY");
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "matches always reports convergence once a keypair exists — this resource never regenerates one",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeKeyReconciler;
      const props = propsFor("/tmp/irrelevant");
      const desired = yield* reconciler.desired(props);
      const observedLikeState = {
        path: desired.path,
        publicKeyPath: desired.publicKeyPath,
        publicKeyType: "ssh-rsa", // deliberately disagrees with `props.algorithm`'s default
        comment: "whatever is already there",
        fingerprint: "SHA256:whatever",
      };
      expect(reconciler.matches(observedLikeState, desired)).toBe(true);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "apply never calls ssh-keygen when `observed` is already Option.some — it returns it untouched",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeKeyReconciler;
      const dyingCtx = {
        exec: () => Effect.die("must not run a command"),
        snapshot: () => Effect.succeed(undefined),
      };
      const props = propsFor("/tmp/irrelevant/id_ed25519");
      const desired = yield* reconciler.desired(props);
      const alreadyThere = {
        path: desired.path,
        publicKeyPath: desired.publicKeyPath,
        publicKeyType: "ssh-ed25519",
        comment: "",
        fingerprint: "SHA256:already-generated",
      };

      const result = yield* reconciler.apply(
        { props, observed: Option.some(alreadyThere), desired },
        dyingCtx,
      );
      expect(result).toEqual(alreadyThere);
    }).pipe(Effect.provide(layer)),
);

it.effect("address is the expanded private key path", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeKeyReconciler;
    expect(reconciler.address(propsFor("/abs/id_ed25519"))).toBe("/abs/id_ed25519");
  }).pipe(Effect.provide(layer)),
);
