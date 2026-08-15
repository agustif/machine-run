import { expect, it } from "@effect/vitest";
import { Sh } from "@machine-run/core";
import { gitCommand } from "../src/command.ts";

it("uses POSIX shell quoting on POSIX", () => {
  expect(gitCommand({ os: "linux", isWindows: false }, "-C", "/tmp/my repo")).toEqual({
    command: Sh.sh("git", "-C", "/tmp/my repo"),
    shell: true,
  });
});

it("uses PowerShell quoting for Windows paths", () => {
  expect(gitCommand({ os: "win32", isWindows: true }, "-C", "C:\\Users\\me\\my repo")).toEqual({
    command: Sh.pwsh("git", "-C", "C:\\Users\\me\\my repo"),
    shell: "powershell.exe",
  });
});
