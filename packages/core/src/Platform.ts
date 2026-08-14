import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { platform as nodePlatform } from "node:os";

/** The operating systems this repo distinguishes behaviourally. */
export type OperatingSystem = "darwin" | "linux" | "win32";

/**
 * Which operating system this run is on, as a service rather than a global read.
 *
 * A service because the answer changes behaviour a reconciler cannot fake: a
 * POSIX `mode` is not representable on Windows (Node reports `0o666` for every
 * file and `chmod` only toggles the read-only bit), so `matches` there has to
 * compare an ACL intent instead of mode bits. Reading `process.platform` at each
 * site would also make that branch untestable — with a service, a test can
 * provide `win32` on a Mac and exercise the Windows path.
 */
export class Platform extends Context.Service<
  Platform,
  {
    readonly os: OperatingSystem;
    readonly isWindows: boolean;
  }
>()("machine-run/Platform") {}

const classify = (raw: string): OperatingSystem =>
  raw === "win32" ? "win32" : raw === "darwin" ? "darwin" : "linux";

/**
 * The real platform, read once. Everything else asks the service, so the branch
 * stays testable and there is no platform read scattered through the resources.
 */
export const PlatformLive = () =>
  Layer.sync(Platform, () => {
    // `os.platform()` rather than `process.platform`, for the same reason
    // `MachinePaths` uses `os.homedir()`: it is the documented API rather than a
    // global whose value a test could have mutated.
    const os = classify(nodePlatform());
    return { os, isWindows: os === "win32" };
  });

/** A fixed platform, for exercising a branch the host cannot reach. */
export const PlatformFor = (os: OperatingSystem) =>
  Layer.succeed(Platform, { os, isWindows: os === "win32" });
