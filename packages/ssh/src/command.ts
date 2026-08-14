import { Platform, Sh } from "@machine-run/core";

/**
 * Builds an OpenSSH command for the host shell Alchemy will invoke.
 *
 * `CommandExecutor` receives one command string rather than an argv array.
 * POSIX quoting is therefore correct on macOS/Linux, while Windows needs
 * PowerShell quoting so drive-letter paths and spaces survive the boundary.
 */
export const sshCommand = (
  platform: typeof Platform.Service,
  ...argv: readonly string[]
):
  | { readonly command: Sh.ShellCommand; readonly shell: "powershell.exe" }
  | { readonly command: Sh.ShellCommand; readonly shell: true } =>
  platform.isWindows
    ? { command: Sh.pwsh("ssh-keygen", ...argv), shell: "powershell.exe" }
    : { command: Sh.sh("ssh-keygen", ...argv), shell: true };
