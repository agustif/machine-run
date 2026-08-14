import { Platform, Sh } from "@machine-run/core";

/**
 * Builds a Git command with the shell and quoting rules of the host platform.
 *
 * Git accepts the same argv on every OS, but Alchemy receives one command
 * string rather than an argv array. `Sh.sh` is correct for POSIX shells and
 * `Sh.pwsh` is correct for Windows PowerShell; using the former on Windows
 * makes a path such as `C:\\Users\\me\\repo` an incorrectly quoted command.
 */
export const gitCommand = (
  platform: typeof Platform.Service,
  ...argv: readonly string[]
):
  | { readonly command: Sh.ShellCommand; readonly shell: "powershell.exe" }
  | { readonly command: Sh.ShellCommand; readonly shell: true } =>
  platform.isWindows
    ? { command: Sh.pwsh("git", ...argv), shell: "powershell.exe" }
    : { command: Sh.sh("git", ...argv), shell: true };
