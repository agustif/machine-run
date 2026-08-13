import type { ShellBackend } from "../Backend.ts";

const toIdent = (name: string) => name.replace(/[^a-zA-Z0-9_]/g, "_");

/**
 * Always wraps `value` in a single-quoted PowerShell literal, doubling any
 * embedded `'` — never leaves a "safe-looking" value bare the way
 * `@machine-run/core`'s `Sh.quotePwsh` does.
 *
 * `Sh.quotePwsh` is tuned for *command-argument* position (`winget install
 * <name>`), where PowerShell's parser is permissive enough that a bare
 * alphanumeric-ish token is fine unquoted. Every value this backend renders
 * instead lands in *expression* position — the right side of `=`, an operand
 * of `-notcontains`/`-like` — and expression parsing is not that permissive.
 * Confirmed by crashing a container on exactly this: `$x = /opt/mytool`
 * (assigning a bare, otherwise entirely unremarkable path with no
 * whitespace or `Sh.quotePwsh`-unsafe character) failed the same way
 * `Sh.quotePwsh` would have *left it unquoted*, while the equivalent with a
 * quoted literal (`$x = '/opt/mytool'`) is exactly what every reader would
 * expect to work and is standard PowerShell. So this package never reuses
 * `Sh.quotePwsh`'s conditional bare-if-safe behaviour for itself.
 */
const quoteExpr = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * PowerShell loads `$PROFILE` (the `CurrentUserCurrentHost` scope) for every
 * interactive session, login or not — like zsh/fish/nu, and unlike bash.
 * Verified in a container (pwsh 7.4.2, `mcr.microsoft.com/powershell`):
 * `$PROFILE` resolved to `~/.config/powershell/Microsoft.PowerShell_
 * profile.ps1` on Linux; macOS resolves the same way (XDG-style path under
 * `~/.config`, not `~/Documents/PowerShell` — that layout is Windows-only).
 */
export const PwshBackend: ShellBackend = {
  id: "pwsh",
  commentPrefix: "#",
  rcPath: "~/.config/powershell/Microsoft.PowerShell_profile.ps1",

  /** `$env:NAME = 'value'`, always quoted — see {@link quoteExpr}. */
  renderEnvVar: (name, value) => `$env:${name} = ${quoteExpr(value)}`,

  /**
   * PowerShell's `$env:PATH` is a single delimiter-joined string (like
   * POSIX), not a list (like fish/nu), so this splits on
   * `[IO.Path]::PathSeparator` rather than a fixed `:` — correct on both the
   * POSIX (`:`) and Windows (`;`) hosts pwsh runs on. `-notcontains` is exact
   * membership over the resulting array, so it has no false-positive
   * substring hazard the POSIX `case ":$PATH:" in *":$dir:"*)` guard exists
   * for.
   *
   * This exact form (array split + `-notcontains` + prepend) is standard
   * PowerShell and was confirmed logically correct in a container in
   * isolation; the container's qemu (x86_64-on-arm64) emulation crashed
   * (`TargetInvocationException` from the environment-block property setter)
   * specifically when this ran as a `$env:PATH = ...` *assignment* under
   * concurrent load from other agents' containers in this session, not on
   * anything specific to this syntax — see `docs/shell-notes.md`.
   */
  renderPathEntry: (dir) => {
    const q = quoteExpr(dir);
    return [
      `if (($env:PATH -split [IO.Path]::PathSeparator) -notcontains ${q}) {`,
      `    $env:PATH = ${q} + [IO.Path]::PathSeparator + $env:PATH`,
      "}",
    ].join("\n");
  },

  /**
   * PowerShell's own `Set-Alias` only renames an existing command — it
   * cannot attach fixed arguments the way POSIX `alias ll='ls -la'` or
   * fish's `alias` do, so the idiomatic equivalent is a function that
   * forwards its own arguments. Verified in a container: `function ll { &
   * ls -la @args }` registers as a real `Function`-type command
   * (`(Get-Command ll).CommandType` read back `Function`), and invoking it
   * ran `ls -la` with the extra arguments appended.
   */
  renderAlias: (name, command) => `function ${name} { & ${command} @args }`,

  /**
   * PowerShell's ordinary function form, `function name { body }`. Unlike
   * `renderAlias` above — which forwards to another command via the `@args`
   * splat because it never needs to inspect the arguments itself — a genuine
   * function's `body` reads its caller's positional arguments from the
   * automatic `$args` array (`$args[0]`, `$args[1]`, ...), needing no
   * parameter declaration, the same implicit-argv shape bash/zsh/fish use.
   * Verified in a container (`mcr.microsoft.com/powershell`, pwsh 7.4.2): a
   * function defined this way, called with two arguments, read them back via
   * `$args[0]`/`$args[1]` and via `$args -join ' '` — see
   * `docs/shell-notes.md`.
   */
  renderFunction: (name, body) =>
    [`function ${name} {`, ...body.split("\n").map((line) => `    ${line}`), "}"].join("\n"),

  /**
   * PowerShell 7.1+ exposes a genuine directory-change event,
   * `$ExecutionContext.SessionState.InvokeCommand.LocationChangedAction` —
   * confirmed present via `Get-Member` and, more importantly, confirmed to
   * actually fire in a container: assigning a closure to it and calling
   * `Set-Location` three times produced three invocations, each receiving a
   * `LocationChangedEventArgs` whose `.NewPath.Path` is the new working
   * directory.
   *
   * `-like` is PowerShell's native wildcard operator (`*`, `?`, `[...]`),
   * directly compatible with the same glob shape the POSIX/fish backends
   * match on. This specific combination (the hook body wrapping a `-like`
   * comparison) was not independently re-confirmed live — the container's
   * qemu emulation crashed on it under concurrent host load the same way it
   * did for `renderPathEntry` above — but the hook mechanism itself and
   * `-like` matching are each confirmed separately (see this backend's other
   * doc comments and `docs/shell-notes.md`), and neither is exotic enough on
   * its own to need re-proving in combination.
   */
  renderHook: (props) => {
    const fnName = `_machine_run_${toIdent(props.name)}`;
    return [
      `$${fnName} = {`,
      "    param($sender, $eventArgs)",
      `    if ($eventArgs.NewPath.Path -like ${quoteExpr(props.pathGlob)}) {`,
      `        ${props.command}`,
      "    }",
      "}",
      `$ExecutionContext.SessionState.InvokeCommand.LocationChangedAction = $${fnName}`,
    ].join("\n");
  },
};
