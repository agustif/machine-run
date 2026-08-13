import { MachinePathsLive } from "@machine-run/core";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import {
  appendKnownHostLine,
  findKnownHostEntry,
  KnownHostKeyMismatch,
  makeKnownHostReconciler,
  parseKnownHosts,
  type KnownHostProps,
} from "../src/KnownHost.ts";

// ---------------------------------------------------------------------------
// Pure parsing — real captured shapes, not invented ones. `github.com`'s
// three lines below are exactly what `ssh-keyscan github.com` printed when
// this was written (comments included, key material trimmed for length —
// the *shape* is what's under test, not a specific host's live key).
// ---------------------------------------------------------------------------

const REAL_GITHUB_KEYSCAN = `# github.com:22 SSH-2.0-feb815a
github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTY=
# github.com:22 SSH-2.0-feb815a
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
# github.com:22 SSH-2.0-feb815a
github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQ==
`;

it("parses every host/keytype/key line, skipping ssh-keyscan's own `#` comment lines", () => {
  const entries = parseKnownHosts(REAL_GITHUB_KEYSCAN);
  expect(entries).toHaveLength(3);
  expect(entries.map((e) => e.keyType)).toEqual(["ecdsa-sha2-nistp256", "ssh-ed25519", "ssh-rsa"]);
  expect(entries[1]).toEqual({
    host: "github.com",
    keyType: "ssh-ed25519",
    publicKey: "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  });
});

it("ignores blank lines", () => {
  expect(parseKnownHosts("\n\n\n")).toEqual([]);
});

it("skips `@cert-authority` and `@revoked` marker lines rather than mis-parsing them as ordinary entries", () => {
  const content = [
    "@cert-authority *.example.com ssh-ed25519 AAAAmarkerkey",
    "@revoked revoked.example.com ssh-rsa AAAArevokedkey",
    "plain.example.com ssh-ed25519 AAAAplainkey",
  ].join("\n");
  const entries = parseKnownHosts(content);
  expect(entries).toEqual([
    { host: "plain.example.com", keyType: "ssh-ed25519", publicKey: "AAAAplainkey" },
  ]);
});

it("skips a line that has a host and keytype but no key material, rather than inventing an empty key", () => {
  expect(parseKnownHosts("incomplete.example.com ssh-ed25519")).toEqual([]);
});

it("findKnownHostEntry matches on host AND keyType — a host with multiple algorithms is not ambiguous", () => {
  const entries = parseKnownHosts(REAL_GITHUB_KEYSCAN);
  expect(findKnownHostEntry(entries, "github.com", "ssh-rsa")?.publicKey).toBe(
    "AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQ==",
  );
  expect(findKnownHostEntry(entries, "github.com", "ecdsa-sha2-nistp384")).toBeUndefined();
  expect(findKnownHostEntry(entries, "gitlab.com", "ssh-rsa")).toBeUndefined();
});

it("appendKnownHostLine adds exactly one line, adding a missing trailing newline first", () => {
  const entry = { host: "h", keyType: "ssh-ed25519", publicKey: "AAAA" };
  expect(appendKnownHostLine("", entry)).toBe("h ssh-ed25519 AAAA\n");
  expect(appendKnownHostLine("existing\n", entry)).toBe("existing\nh ssh-ed25519 AAAA\n");
  expect(appendKnownHostLine("existing-no-newline", entry)).toBe(
    "existing-no-newline\nh ssh-ed25519 AAAA\n",
  );
});

// ---------------------------------------------------------------------------
// The reconciler, against a real temp file.
// ---------------------------------------------------------------------------

const layer = MachinePathsLive().pipe(Layer.provideMerge(NodeServices.layer));

const observeCtx = { exec: () => Effect.die("Ssh.KnownHost never runs a command") };
const applyCtx = { ...observeCtx, snapshot: () => Effect.succeed(undefined) };

const propsFor = (path: string, overrides: Partial<KnownHostProps> = {}): KnownHostProps => ({
  path,
  host: "github.com",
  keyType: "ssh-ed25519",
  publicKey: "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  ...overrides,
});

it.effect("observe reports absent for a file that does not exist yet", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeKnownHostReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "known_hosts");

    expect(yield* reconciler.observe(propsFor(target), observeCtx)).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("apply creates the file and writes exactly one line for a brand-new entry", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeKnownHostReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "known_hosts");

    const props = propsFor(target);
    const desired = yield* reconciler.desired(props);
    yield* reconciler.apply({ props, observed: undefined, desired }, applyCtx);

    const written = yield* fs.readFileString(target);
    expect(written).toBe(`github.com ssh-ed25519 ${props.publicKey}\n`);

    const info = yield* fs.stat(target);
    expect(Number(info.mode) & 0o777).toBe(0o644);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("apply creates ~/.ssh (the file's parent) at 0o700", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeKnownHostReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, ".ssh", "known_hosts");

    const props = propsFor(target);
    const desired = yield* reconciler.desired(props);
    yield* reconciler.apply({ props, observed: undefined, desired }, applyCtx);

    const info = yield* fs.stat(path.dirname(target));
    expect(Number(info.mode) & 0o777).toBe(0o700);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("a second, unrelated entry appends alongside the first without disturbing it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeKnownHostReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "known_hosts");

    const first = propsFor(target);
    const firstDesired = yield* reconciler.desired(first);
    yield* reconciler.apply({ props: first, observed: undefined, desired: firstDesired }, applyCtx);

    const second = propsFor(target, {
      host: "gitlab.com",
      keyType: "ssh-rsa",
      publicKey: "AAAAB3NzaC1yc2Uh",
    });
    const secondDesired = yield* reconciler.desired(second);
    yield* reconciler.apply(
      { props: second, observed: undefined, desired: secondDesired },
      applyCtx,
    );

    const written = yield* fs.readFileString(target);
    expect(written).toBe(
      `github.com ssh-ed25519 ${first.publicKey}\ngitlab.com ssh-rsa AAAAB3NzaC1yc2Uh\n`,
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "matches is satisfied only when host, keyType and the pinned key all agree with what's on the line",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeKnownHostReconciler;
      const props = propsFor("/tmp/irrelevant-known_hosts");
      const desired = yield* reconciler.desired(props);

      expect(reconciler.matches(desired, desired)).toBe(true);
      expect(reconciler.matches({ ...desired, publicKey: "AAAAdifferentkey" }, desired)).toBe(
        false,
      );
      expect(reconciler.matches({ ...desired, host: "other.example.com" }, desired)).toBe(false);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a pinned key that disagrees with an existing line raises KnownHostKeyMismatch — it neither overwrites nor appends a duplicate",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeKnownHostReconciler;
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = path.join(dir, "known_hosts");

      const staleKey = "AAAAC3NzaC1lZDI1NTE5-stale-key-already-there";
      yield* fs.writeFileString(target, `github.com ssh-ed25519 ${staleKey}\n`);

      const props = propsFor(target); // pins a *different* key for the same host/keyType
      const observed = yield* reconciler.observe(props, observeCtx);
      const desired = yield* reconciler.desired(props);
      expect(reconciler.matches(observed!, desired)).toBe(false);

      const error = yield* reconciler
        .apply({ props, observed, desired }, applyCtx)
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(KnownHostKeyMismatch);

      // Neither guess was made: the stale line is untouched, and no second
      // line was appended for the same host/keyType.
      const stillThere = yield* fs.readFileString(target);
      expect(stillThere).toBe(`github.com ssh-ed25519 ${staleKey}\n`);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "address is the whole known_hosts path, not one entry — so two entries in the same file share a lock",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeKnownHostReconciler;
      const first = propsFor("~/.ssh/known_hosts", { host: "github.com" });
      const second = propsFor("~/.ssh/known_hosts", {
        host: "gitlab.com",
        keyType: "ssh-rsa",
        publicKey: "AAAAdifferent",
      });
      expect(reconciler.address(first)).toBe(reconciler.address(second));
    }).pipe(Effect.provide(layer)),
);

it.effect("defaults `path` to ~/.ssh/known_hosts when not given", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeKnownHostReconciler;
    const withoutPath: KnownHostProps = {
      host: "github.com",
      keyType: "ssh-ed25519",
      publicKey: "AAAA",
    };
    expect(reconciler.address(withoutPath)).toBe(
      reconciler.address(propsFor("~/.ssh/known_hosts")),
    );
  }).pipe(Effect.provide(layer)),
);
