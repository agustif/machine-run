import { MachinePathsLive, PlatformFor } from "@machine-run/core";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { platform as nodePlatform } from "node:os";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import {
  appendKnownHostLine,
  findKnownHostEntry,
  KnownHostKeyMismatch,
  KnownHostsHashMalformed,
  makeKnownHostReconciler,
  parseKnownHosts,
  removeKnownHostLine,
  type KnownHostProps,
} from "../src/KnownHost.ts";

const POSIX_PERMISSIONS_AVAILABLE = nodePlatform() !== "win32";

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

// Captured from `ssh-keygen -H` applied to the first github.com line above.
// OpenSSH stores one independently salted HMAC-SHA1 hostname per line.
const HASHED_GITHUB =
  "|1|hzrL6k1tG4MUvZfOy5PY5Ztm2ZA=|7rS++odH2vEXi1Z9X0GHFAg643I= ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n";

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

it("does not expose hashed host fields as literal hostnames", () => {
  expect(parseKnownHosts(HASHED_GITHUB)).toEqual([]);
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

it("removeKnownHostLine drops exactly the matching line and nothing else", () => {
  const entries = parseKnownHosts(REAL_GITHUB_KEYSCAN);
  const target = findKnownHostEntry(entries, "github.com", "ssh-ed25519");
  expect(target).toBeDefined();

  const removed = removeKnownHostLine(REAL_GITHUB_KEYSCAN, target!);
  expect(parseKnownHosts(removed)).toEqual(entries.filter((e) => e.keyType !== "ssh-ed25519"));
  // Comment lines are untouched — same disinterest as parseKnownHosts.
  expect(removed).toContain("# github.com:22 SSH-2.0-feb815a");
});

it("removeKnownHostLine is a no-op when no line matches", () => {
  const entry = { host: "nowhere.example.com", keyType: "ssh-ed25519", publicKey: "AAAA" };
  expect(removeKnownHostLine(REAL_GITHUB_KEYSCAN, entry)).toBe(REAL_GITHUB_KEYSCAN);
});

// ---------------------------------------------------------------------------
// CRLF content — Windows OpenSSH writes `known_hosts` with `\r\n`.
// `parseKnownHosts`'s own field extraction happens to survive a naive
// `content.split("\n")` because `String.prototype.trim()` strips a lone
// trailing `\r` as a LineTerminator character — verified directly below —
// but `appendKnownHostLine` hardcoding a bare `\n` does not survive it: it
// silently turns a consistently-CRLF file into one whose newest line is the
// only one not terminated the same way as the rest.
// ---------------------------------------------------------------------------

it("parseKnownHosts extracts a clean key from a CRLF known_hosts line", () => {
  const content = "github.com ssh-ed25519 AAAAKEYDATA\r\ngitlab.com ssh-rsa BBBBKEYDATA\r\n";
  expect(parseKnownHosts(content)).toEqual([
    { host: "github.com", keyType: "ssh-ed25519", publicKey: "AAAAKEYDATA" },
    { host: "gitlab.com", keyType: "ssh-rsa", publicKey: "BBBBKEYDATA" },
  ]);
});

it("appendKnownHostLine preserves an existing CRLF file's line endings for the newly appended line", () => {
  const entry = { host: "gitlab.com", keyType: "ssh-ed25519", publicKey: "BBBB" };
  const existing = "github.com ssh-ed25519 AAAA\r\n";
  // The load-bearing assertion: before the fix, this produces
  // `"github.com ssh-ed25519 AAAA\r\ngitlab.com ssh-ed25519 BBBB\n"` — the
  // pre-existing line stays `\r\n`-terminated but the newly appended one
  // becomes bare `\n`, a mixed-convention file this tool itself introduced.
  expect(appendKnownHostLine(existing, entry)).toBe(
    "github.com ssh-ed25519 AAAA\r\ngitlab.com ssh-ed25519 BBBB\r\n",
  );
});

it.effect("CRLF known_hosts: a second entry is appended using the file's own CRLF convention", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeKnownHostReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "known_hosts");

    yield* fs.writeFileString(target, "github.com ssh-ed25519 AAAA\r\n");

    const props = propsFor(target, {
      host: "gitlab.com",
      keyType: "ssh-rsa",
      publicKey: "BBBB",
    });
    const desired = yield* reconciler.desired(props);
    yield* reconciler.apply({ props, observed: Option.none(), desired }, applyCtx);

    const written = yield* fs.readFileString(target);
    expect(written).toBe("github.com ssh-ed25519 AAAA\r\ngitlab.com ssh-rsa BBBB\r\n");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

// ---------------------------------------------------------------------------
// The reconciler, against a real temp file.
// ---------------------------------------------------------------------------

const layer = Layer.mergeAll(MachinePathsLive(), PlatformFor("linux")).pipe(
  Layer.provideMerge(NodeServices.layer),
);

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

    expect(Option.isNone(yield* reconciler.observe(propsFor(target), observeCtx))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("observe matches an OpenSSH HashKnownHosts entry using its stored salt", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeKnownHostReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "known_hosts");

    yield* fs.writeFileString(target, HASHED_GITHUB);

    const observed = yield* reconciler.observe(propsFor(target), observeCtx);
    expect(observed).toEqual(
      Option.some({
        path: target,
        host: "github.com",
        keyType: "ssh-ed25519",
        publicKey: "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("matches each hostname when OpenSSH hashes a comma-separated host field separately", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeKnownHostReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "known_hosts");
    yield* fs.writeFileString(target, HASHED_GITHUB);

    const props = propsFor(target, { host: "github.com,140.82.121.3" });
    const observed = yield* reconciler.observe(props, observeCtx);
    expect(observed).toEqual(
      Option.some({
        path: target,
        host: props.host,
        keyType: props.keyType,
        publicKey: props.publicKey,
      }),
    );

    const desired = yield* reconciler.desired(props);
    yield* reconciler.unapply!({ props, observed: desired, recorded: desired }, applyCtx);
    expect(yield* fs.readFileString(target)).toBe("");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("fails loudly on a malformed hashed known_hosts entry", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeKnownHostReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "known_hosts");
    yield* fs.writeFileString(target, "|1|not-base64|still-not-base64 ssh-ed25519 AAAA\n");

    const error = yield* reconciler.observe(propsFor(target), observeCtx).pipe(Effect.flip);
    expect(error).toBeInstanceOf(KnownHostsHashMalformed);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect.skipIf(!POSIX_PERMISSIONS_AVAILABLE)(
  "apply creates the file and writes exactly one line for a brand-new entry",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeKnownHostReconciler;
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = path.join(dir, "known_hosts");

      const props = propsFor(target);
      const desired = yield* reconciler.desired(props);
      yield* reconciler.apply({ props, observed: Option.none(), desired }, applyCtx);

      const written = yield* fs.readFileString(target);
      expect(written).toBe(`github.com ssh-ed25519 ${props.publicKey}\n`);

      const info = yield* fs.stat(target);
      expect(Number(info.mode) & 0o777).toBe(0o644);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect.skipIf(!POSIX_PERMISSIONS_AVAILABLE)(
  "apply creates ~/.ssh (the file's parent) at 0o700",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeKnownHostReconciler;
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = path.join(dir, ".ssh", "known_hosts");

      const props = propsFor(target);
      const desired = yield* reconciler.desired(props);
      yield* reconciler.apply({ props, observed: Option.none(), desired }, applyCtx);

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
    yield* reconciler.apply(
      { props: first, observed: Option.none(), desired: firstDesired },
      applyCtx,
    );

    const second = propsFor(target, {
      host: "gitlab.com",
      keyType: "ssh-rsa",
      publicKey: "AAAAB3NzaC1yc2Uh",
    });
    const secondDesired = yield* reconciler.desired(second);
    yield* reconciler.apply(
      { props: second, observed: Option.none(), desired: secondDesired },
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

// --- drift: agrees with matches; every field is categorical, none get a direction. ---

it.effect("drift is empty exactly when matches is true", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeKnownHostReconciler;
    const props = propsFor("/tmp/irrelevant-known_hosts");
    const desired = yield* reconciler.desired(props);

    expect(reconciler.matches(desired, desired)).toBe(true);
    expect(reconciler.drift?.(desired, desired)).toEqual([]);
  }).pipe(Effect.provide(layer)),
);

it.effect("drift reports a 'key' field, with no direction, for a differing publicKey", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeKnownHostReconciler;
    const props = propsFor("/tmp/irrelevant-known_hosts");
    const desired = yield* reconciler.desired(props);
    const observed = { ...desired, publicKey: "AAAAdifferentkey" };

    expect(reconciler.matches(observed, desired)).toBe(false);
    expect(reconciler.drift?.(observed, desired)).toEqual([
      { field: "key", observed: "AAAAdifferentkey", desired: desired.publicKey },
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("drift reports a 'host' field for a differing host", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeKnownHostReconciler;
    const props = propsFor("/tmp/irrelevant-known_hosts");
    const desired = yield* reconciler.desired(props);
    const observed = { ...desired, host: "other.example.com" };

    expect(reconciler.matches(observed, desired)).toBe(false);
    expect(reconciler.drift?.(observed, desired)).toEqual([
      { field: "host", observed: "other.example.com", desired: desired.host },
    ]);
  }).pipe(Effect.provide(layer)),
);

// --- unapply: removes the exact line apply wrote — a real, safe reverse. ---

it.effect("unapply removes the line apply wrote, leaving everything else untouched", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeKnownHostReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "known_hosts");

    const first = propsFor(target);
    const firstDesired = yield* reconciler.desired(first);
    yield* reconciler.apply(
      { props: first, observed: Option.none(), desired: firstDesired },
      applyCtx,
    );

    const second = propsFor(target, {
      host: "gitlab.com",
      keyType: "ssh-rsa",
      publicKey: "AAAAB3NzaC1yc2Uh",
    });
    const secondDesired = yield* reconciler.desired(second);
    yield* reconciler.apply(
      { props: second, observed: Option.none(), desired: secondDesired },
      applyCtx,
    );

    yield* reconciler.unapply!(
      { props: second, observed: secondDesired, recorded: secondDesired },
      applyCtx,
    );

    const written = yield* fs.readFileString(target);
    expect(written).toBe(`github.com ssh-ed25519 ${first.publicKey}\n`);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "unapply is a no-op when the live line no longer matches what was recorded — it never guesses",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeKnownHostReconciler;
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = path.join(dir, "known_hosts");

      const props = propsFor(target);
      const recorded = yield* reconciler.desired(props);
      // The file's line has since changed to a different key — hand-edited,
      // or re-pinned by a later run — so it is no longer this resource's own
      // contribution.
      const changedLine = { ...recorded, publicKey: "AAAAsomeoneelsespinnedthis" };
      yield* fs.writeFileString(
        target,
        `${recorded.host} ${recorded.keyType} ${changedLine.publicKey}\n`,
      );

      yield* reconciler.unapply!({ props, observed: changedLine, recorded }, applyCtx);

      const written = yield* fs.readFileString(target);
      expect(written).toBe(`${recorded.host} ${recorded.keyType} ${changedLine.publicKey}\n`);
    }).pipe(Effect.scoped, Effect.provide(layer)),
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
      expect(reconciler.matches(Option.getOrThrow(observed), desired)).toBe(false);

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
