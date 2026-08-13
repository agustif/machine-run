import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import type { PackageManagerId } from "./Package.ts";

/**
 * Raised when this machine's platform has no package-manager backend.
 *
 * Detection fails here, at composition time, rather than returning a plausible
 * default: a manager that does not exist on this platform surfaces as
 * `command not found` from inside an unrelated reconcile, long after the
 * information needed to explain it is gone.
 */
export class UnsupportedPlatform extends Data.TaggedError("UnsupportedPlatform")<{
  platform: string;
}> {
  override get message() {
    return `No system package manager backend for platform "${this.platform}". Supported: darwin (brew/port), linux (apt/dnf/pacman) and win32 (winget/choco). Pass \`manager\` explicitly if you know which one this machine has.`;
  }
}

/**
 * A distro probe: a missing file means "not this distro", and so does an
 * unreadable one. The failure is absorbed here, at the individual probe,
 * rather than by widening the whole detection's declared error channel.
 */
const probe = (fs: FileSystem.FileSystem, path: string) =>
  fs.exists(path).pipe(Effect.orElseSucceed(() => false));

/**
 * Marker files that identify a Linux distro family, in priority order.
 *
 * Order matters: a derivative distro can carry more than one of these, and the
 * first match wins.
 */
const LINUX_FAMILIES = [
  { marker: "/etc/debian_version", manager: "apt" },
  { marker: "/etc/redhat-release", manager: "dnf" },
  { marker: "/etc/arch-release", manager: "pacman" },
] as const satisfies ReadonlyArray<{ marker: string; manager: PackageManagerId }>;

const linuxManager = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  for (const { marker, manager } of LINUX_FAMILIES) {
    if (yield* probe(fs, marker)) return manager;
  }
  // Homebrew on Linux is a real and common answer for distros outside those
  // families, unlike on Windows where it does not exist at all.
  return "brew" as const;
});

/**
 * Picks the package manager native to this machine's OS, at recipe composition
 * time — no `CommandExecutor` or session needed, just `process.platform` and a
 * few filesystem probes for the Linux distro family.
 *
 * This answers "which manager is native to this OS", not "which manager is
 * installed": it deliberately never shells out. A recipe that wants a
 * non-default manager for its platform — MacPorts over Homebrew, Chocolatey
 * over winget — states it rather than being detected into it.
 */
export const detectSystemPackageManager: Effect.Effect<
  PackageManagerId,
  UnsupportedPlatform,
  FileSystem.FileSystem
> = Effect.suspend(() =>
  Match.value(process.platform).pipe(
    Match.when("darwin", () => Effect.succeed<PackageManagerId>("brew")),
    Match.when("linux", () => linuxManager),
    Match.when("win32", () => Effect.succeed<PackageManagerId>("winget")),
    Match.orElse((platform) => Effect.fail(new UnsupportedPlatform({ platform }))),
  ),
);
