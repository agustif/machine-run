import * as http from "node:http";
import { createHash } from "node:crypto";
import { NodeServices } from "@effect/platform-node";
import { MachinePathsLive } from "@machine-run/core";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  DownloadChecksumMismatch,
  DownloadPathIsNotFile,
  DownloadTooLarge,
  makeDownloadReconciler,
  type DownloadProps,
  type DownloadState,
} from "../src/Download.ts";

/**
 * A real HTTP server on a loopback port, not a fake `HttpClient` — the
 * requirement this resource exists to satisfy is "verify a real download
 * before it lands on disk", so the test has to exercise a real fetch over a
 * real socket, not a stand-in that can't lie the way a real server would.
 */
const withServer = (body: Uint8Array) =>
  Effect.acquireRelease(
    Effect.callback<{ server: http.Server; url: string }>((resume) => {
      const server = http.createServer((_req, res) => {
        res.writeHead(200);
        res.end(Buffer.from(body));
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        resume(Effect.succeed({ server, url: `http://127.0.0.1:${port}/file` }));
      });
    }),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const layer = Layer.mergeAll(MachinePathsLive(), FetchHttpClient.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const BODY = new TextEncoder().encode("machine-run test fixture, not a real font");
const CHECKSUM = sha256Hex(BODY);

it.effect("observe reports nothing for a file that has not been fetched yet", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeDownloadReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "font.ttf");

    const observed = yield* reconciler.observe(
      {
        url: "http://127.0.0.1:1/unreachable",
        path: target,
        checksum: CHECKSUM,
      },
      { exec: () => Effect.die("not used") },
    );
    expect(observed).toStrictEqual(Option.none());
  }).pipe(Effect.provide(layer)),
);

it.effect("apply fetches, verifies the checksum, and writes the bytes atomically", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeDownloadReconciler;
    const { url } = yield* withServer(BODY);
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "font.ttf");

    const props: DownloadProps = { url, path: target, checksum: CHECKSUM, mode: 0o644 };
    const desired = yield* reconciler.desired(props);
    const result = yield* reconciler.apply(
      { props, observed: Option.none(), desired },
      { exec: () => Effect.die("not used"), snapshot: () => Effect.succeed(undefined) },
    );

    expect(result.hash).toBe(CHECKSUM);
    expect(result.mode).toBe(0o644);

    const written = yield* fs.readFile(target);
    expect(Buffer.from(written).equals(Buffer.from(BODY))).toBe(true);

    // A later plan reads the file back and finds it already converged.
    const observedAfter = yield* reconciler.observe(props, {
      exec: () => Effect.die("not used"),
    });
    expect(Option.isSome(observedAfter)).toBe(true);
    expect(reconciler.matches(Option.getOrThrow(observedAfter), desired)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("a checksum mismatch fails without ever writing the file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeDownloadReconciler;
    const { url } = yield* withServer(BODY);
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "font.ttf");

    const wrongChecksum = sha256Hex(new TextEncoder().encode("something else entirely"));
    const props: DownloadProps = { url, path: target, checksum: wrongChecksum };
    const desired = yield* reconciler.desired(props);

    const error = yield* reconciler
      .apply(
        { props, observed: Option.none(), desired },
        {
          exec: () => Effect.die("not used"),
          snapshot: () => Effect.succeed(undefined),
        },
      )
      .pipe(Effect.flip);

    expect(error).toBeInstanceOf(DownloadChecksumMismatch);
    if (error instanceof DownloadChecksumMismatch) {
      expect(error.expected).toBe(wrongChecksum);
      expect(error.actual).toBe(CHECKSUM);
    }
    // The whole point: a failed verification must never leave a corrupt
    // or unexpected file sitting at the destination path.
    expect(yield* fs.exists(target)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("observe fails with a typed error when a directory occupies the path", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeDownloadReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "not-a-file");
    yield* fs.makeDirectory(target);

    const error = yield* reconciler
      .observe(
        { url: "http://127.0.0.1:1/unreachable", path: target, checksum: CHECKSUM },
        { exec: () => Effect.die("not used") },
      )
      .pipe(Effect.flip);
    expect(error).toBeInstanceOf(DownloadPathIsNotFile);
  }).pipe(Effect.provide(layer)),
);

it.effect("desired never contacts the network — it reads straight from `checksum`", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeDownloadReconciler;
    const desired = yield* reconciler.desired({
      url: "http://127.0.0.1:1/unreachable-and-never-called",
      path: "/tmp/whatever",
      checksum: CHECKSUM,
    });
    expect(desired.hash).toBe(CHECKSUM);
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses an artifact larger than `maxBytes` instead of holding it in memory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeDownloadReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "big.bin");

    const { url } = yield* withServer(BODY);

    const failure = yield* reconciler
      .apply(
        {
          props: {
            url,
            path: target,
            checksum: CHECKSUM,
            // Smaller than the fixture, so the guard is what stops it
            // rather than the fixture being trivially small.
            maxBytes: 8,
          },
          observed: Option.none(),
          desired: { path: target, hash: CHECKSUM },
        },
        { exec: () => Effect.die("not used"), snapshot: () => Effect.succeed(undefined) },
      )
      .pipe(Effect.flip);

    expect(failure).toBeInstanceOf(DownloadTooLarge);
    // Nothing may land at the target: an artifact too large to verify is
    // indistinguishable from an unverified one.
    expect(yield* fs.exists(target)).toBe(false);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "refuses to hash an oversized file already on disk, so planning cannot exhaust memory",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeDownloadReconciler;
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = path.join(dir, "big.bin");
      yield* fs.writeFile(target, BODY);

      const failure = yield* reconciler
        .observe(
          { url: "http://127.0.0.1:1/unused", path: target, checksum: CHECKSUM, maxBytes: 8 },
          { exec: () => Effect.die("not used") },
        )
        .pipe(Effect.flip);

      expect(failure).toBeInstanceOf(DownloadTooLarge);
    }).pipe(Effect.provide(layer)),
);

/**
 * A read-only final mode. This is the case that makes the temp file's
 * pre-write restriction non-trivial: the window has to be closed with a mode
 * that is still writable by us, because chmod'ing straight to 0444 and then
 * writing fails with EACCES — for the owner too, which is easy to assume
 * otherwise. Asserting a read-only download still succeeds is what keeps that
 * ordering from regressing.
 */
it.effect("a read-only mode still downloads, and lands read-only", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeDownloadReconciler;
    const { url } = yield* withServer(BODY);
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "pinned.ttf");

    const props: DownloadProps = { url, path: target, checksum: CHECKSUM, mode: 0o444 };
    const desired = yield* reconciler.desired(props);
    const result = yield* reconciler.apply(
      { props, observed: Option.none(), desired },
      { exec: () => Effect.die("not used"), snapshot: () => Effect.succeed(undefined) },
    );

    expect(result.mode).toBe(0o444);
    const written = yield* fs.readFile(target);
    expect(Buffer.from(written).equals(Buffer.from(BODY))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

/** A download that expresses no opinion about mode keeps the platform
 * default, rather than being quietly tightened by the fix above. */
it.effect("a download with no mode is left at the platform default", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeDownloadReconciler;
    const { url } = yield* withServer(BODY);
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "unmoded.ttf");

    const props: DownloadProps = { url, path: target, checksum: CHECKSUM };
    const desired = yield* reconciler.desired(props);
    const result = yield* reconciler.apply(
      { props, observed: Option.none(), desired },
      { exec: () => Effect.die("not used"), snapshot: () => Effect.succeed(undefined) },
    );

    expect(result.mode).not.toBe(0o600);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("drift is empty exactly when matches is true, and names content and mode", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeDownloadReconciler;
    const drift = reconciler.drift;
    if (drift === undefined) return yield* Effect.die("expected drift to be defined");

    const desired: DownloadState = {
      path: "/tmp/font.ttf",
      hash: CHECKSUM,
      mode: 0o644,
    };
    const satisfied = { path: "/tmp/font.ttf", hash: CHECKSUM, mode: 0o644 };
    expect(reconciler.matches(satisfied, desired)).toBe(true);
    expect(drift(satisfied, desired)).toEqual([]);

    const wrongHash = { path: "/tmp/font.ttf", hash: "0".repeat(64), mode: 0o644 };
    expect(reconciler.matches(wrongHash, desired)).toBe(false);
    expect(drift(wrongHash, desired).map((f) => f.field)).toEqual(["content"]);

    const wrongMode = { path: "/tmp/font.ttf", hash: CHECKSUM, mode: 0o600 };
    expect(reconciler.matches(wrongMode, desired)).toBe(false);
    expect(drift(wrongMode, desired)).toEqual([
      { field: "mode", observed: "600", desired: "644", direction: "behind" },
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("unapply removes the verified file it wrote", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeDownloadReconciler;
    const unapply = reconciler.unapply;
    if (unapply === undefined) return yield* Effect.die("expected unapply to be defined");
    const { url } = yield* withServer(BODY);
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "font.ttf");

    const props: DownloadProps = { url, path: target, checksum: CHECKSUM };
    const desired = yield* reconciler.desired(props);
    const output = yield* reconciler.apply(
      { props, observed: Option.none(), desired },
      { exec: () => Effect.die("not used"), snapshot: () => Effect.succeed(undefined) },
    );

    const observed = Option.getOrThrow(
      yield* reconciler.observe(props, { exec: () => Effect.die("not used") }),
    );
    yield* unapply(
      { props, observed, recorded: output },
      { exec: () => Effect.die("not used"), snapshot: () => Effect.succeed(undefined) },
    );

    expect(yield* fs.exists(target)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
