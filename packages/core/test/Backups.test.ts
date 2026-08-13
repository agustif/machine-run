import { expect, it } from "@effect/vitest";
import { mirrorSegments } from "../src/Backups.ts";

/**
 * A backup is only a safety net if its destination can actually be created.
 *
 * These are unit tests on the path rewrite rather than on `snapshot` itself,
 * because the failure they pin is unreachable from a POSIX machine: it needs a
 * Windows-shaped absolute path, and the consequence of getting it wrong is
 * silent by design — `snapshot` logs a warning and returns no path rather than
 * aborting the deploy, so the overwrite proceeds regardless.
 */
it("keeps a Windows drive letter as an ordinary segment, without its colon", () => {
  // `:` is forbidden in a Windows path segment, so mirroring `C:\...`
  // verbatim asks for a directory named `C:` and the backup cannot be written
  // at all.
  expect(mirrorSegments("C:\\Users\\me\\.zshrc")).toEqual(["C", "Users", "me", ".zshrc"]);
  expect(mirrorSegments("D:\\a\\repo\\file.txt")).toEqual(["D", "a", "repo", "file.txt"]);
  expect(mirrorSegments("C:/Users/me/.gitconfig")).toEqual(["C", "Users", "me", ".gitconfig"]);
});

it("no segment ever contains a character Windows forbids in a path", () => {
  const forbidden = /[<>:"|?*]/;
  for (const input of [
    "C:\\Users\\me\\.zshrc",
    "\\\\server\\share\\config",
    "/home/me/.config/git/config",
  ]) {
    expect(mirrorSegments(input).some((segment) => forbidden.test(segment))).toBe(false);
  }
});

it("distinguishes a UNC host and share from a local directory of the same name", () => {
  expect(mirrorSegments("\\\\server\\share\\config")).toEqual(["UNC", "server", "share", "config"]);
  // Without the prefix these two would mirror to the same destination and one
  // backup would silently overwrite the other.
  expect(mirrorSegments("/server/share/config")).toEqual(["server", "share", "config"]);
});

it("mirrors a POSIX path as its segments, with the leading slash dropped", () => {
  // Dropped so the result nests *under* the run directory rather than
  // resolving back to the filesystem root.
  expect(mirrorSegments("/home/me/.zshrc")).toEqual(["home", "me", ".zshrc"]);
  expect(mirrorSegments("/etc/hosts")).toEqual(["etc", "hosts"]);
});

it("keeps two files sharing a basename apart", () => {
  // The reason the full source path is mirrored at all: `config` is a name
  // many tools use, and keying a backup by basename alone loses one of them.
  expect(mirrorSegments("/home/me/.ssh/config")).not.toEqual(
    mirrorSegments("/home/me/.config/git/config"),
  );
});
