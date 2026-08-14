import * as http from "node:http";
import { createHash } from "node:crypto";
import { NodeServices } from "@effect/platform-node";
import { MachinePathsLive, PlatformLive } from "@machine-run/core";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { makeDownloadReconciler, type DownloadProps } from "../src/Download.ts";

/**
 * Explicit live coverage for the transport boundary. This file is excluded
 * from the default suite because loopback sockets are not available in every
 * supported sandbox; the CI live job runs it on a normal runner.
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

const BODY = new TextEncoder().encode("machine-run live download fixture");
const CHECKSUM = createHash("sha256").update(BODY).digest("hex");
const layer = Layer.mergeAll(MachinePathsLive(), PlatformLive(), FetchHttpClient.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.effect("fetches a verified artifact through a real loopback HTTP server", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeDownloadReconciler;
    const { url } = yield* withServer(BODY);
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "font.ttf");
    const props: DownloadProps = { url, path: target, checksum: CHECKSUM };
    const desired = yield* reconciler.desired(props);

    const result = yield* reconciler.apply(
      { props, observed: Option.none(), desired },
      { exec: () => Effect.die("not used"), snapshot: () => Effect.succeed(undefined) },
    );

    expect(result.hash).toBe(CHECKSUM);
    expect(Buffer.from(yield* fs.readFile(target)).equals(Buffer.from(BODY))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
