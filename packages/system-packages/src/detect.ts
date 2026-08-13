import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { PackageManagerId } from "./Package.ts";

/**
 * Picks which OS package manager this machine should use, at recipe
 * composition time (no `CommandExecutor`/session needed — just `process.platform`
 * and a couple of `FileSystem.exists` checks for the Linux distro family).
 */
export const detectSystemPackageManager: Effect.Effect<
  PackageManagerId,
  never,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const platform = yield* Effect.sync(() => process.platform);
  if (platform === "darwin") return "brew" as const;

  const fs = yield* FileSystem.FileSystem;
  if (yield* fs.exists("/etc/debian_version")) return "apt" as const;
  if (yield* fs.exists("/etc/redhat-release")) return "dnf" as const;
  if (yield* fs.exists("/etc/arch-release")) return "pacman" as const;
  return "brew" as const;
});
