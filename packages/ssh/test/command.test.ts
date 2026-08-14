import { expect, it } from "@effect/vitest";
import { Sh } from "@machine-run/core";
import { sshCommand } from "../src/command.ts";

it("uses POSIX shell quoting on POSIX", () => {
  expect(sshCommand({ os: "linux", isWindows: false }, "-lf", "/tmp/my key.pub")).toEqual({
    command: Sh.sh("ssh-keygen", "-lf", "/tmp/my key.pub"),
    shell: true,
  });
});

it("uses PowerShell quoting for Windows key paths", () => {
  expect(sshCommand({ os: "win32", isWindows: true }, "-lf", "C:\\Users\\me\\my key.pub")).toEqual({
    command: Sh.pwsh("ssh-keygen", "-lf", "C:\\Users\\me\\my key.pub"),
    shell: "powershell.exe",
  });
});
