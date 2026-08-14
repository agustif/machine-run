import * as Brand from "effect/Brand";

/**
 * POSIX shell quoting for commands built out of untrusted-ish values
 * (package names, `defaults` values, 1Password refs, repo specs).
 *
 * ## Why this exists
 *
 * Alchemy's `CommandExecutor` takes a single `command: string`, never an
 * argv array. It has exactly two modes, and neither is safe on its own:
 *
 * - `shell: false` (the default) — Alchemy splits the string on whitespace
 *   (`command.split(/(\s+)/)`) and execs the parts directly. It does **not**
 *   understand quotes, so `brew install "my pkg"` execs `brew` with the
 *   literal args `"my` and `pkg"`, and `dpkg-query -f '${x}\n'` passes the
 *   single quotes through to dpkg-query verbatim.
 * - `shell: true` — the string goes to `/bin/sh`, which *does* understand
 *   quotes, but also understands `;`, `&&`, backticks and `$(...)`.
 *
 * So any command carrying a value must use `shell: true` **and** quote that
 * value. This module is that quoting.
 *
 * This is POSIX `sh` quoting specifically. It is not correct for `cmd.exe`;
 * a Windows backend needs its own quoting and must not reuse this.
 *
 * ## `ShellCommand`
 *
 * {@link sh} and {@link pwsh} used to return a bare `string` —
 * indistinguishable from a command built by unsafe template-literal
 * interpolation. A caller-supplied value was interpolated raw into a command
 * that got written into a shell rc file precisely because nothing at the
 * type level told the two apart. `ShellCommand` is that distinction, made a
 * type: only {@link sh}, {@link pwsh} and the explicit {@link unsafeRaw}
 * escape hatch can produce one.
 */
export type ShellCommand = Brand.Branded<string, "ShellCommand">;

/**
 * The one place a `string` becomes a `ShellCommand`. `Brand.nominal` performs
 * no runtime check — quoting already happened in {@link sh}/{@link pwsh}, and
 * {@link unsafeRaw} is a deliberate, named escape hatch rather than something
 * a validator could catch — so this is nominal branding, not refinement.
 */
const asShellCommand: Brand.Constructor<ShellCommand> = Brand.nominal<ShellCommand>();

/** Characters that are safe unquoted in every POSIX shell. */
const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quotes one argument for POSIX `sh`.
 *
 * Single-quoting is the only form that suppresses *all* expansion, so it's
 * what we use; an embedded `'` is emitted as `'\''` (close, escaped quote,
 * reopen), which is the standard idiom.
 */
export const quote = (arg: string): string => {
  if (arg.length === 0) return "''";
  if (SAFE.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
};

/**
 * Builds a `shell: true`-safe command string from an argv array.
 *
 * The first element is the binary and is quoted like everything else, so
 * `sh("brew", "install", name)` can never be turned into a second command by
 * a hostile `name`.
 *
 * ```ts
 * executor.run({ command: sh("brew", "install", name), shell: true }, session)
 * ```
 */
export const sh = (...argv: readonly string[]): ShellCommand =>
  asShellCommand(argv.map(quote).join(" "));

/**
 * Builds a command string that references environment variables rather than
 * inlining their values — the only correct shape for anything secret, since
 * an inlined secret is visible in `ps` output and in any `CommandError`
 * message, while Alchemy redacts values passed as `Redacted` through `env`.
 *
 * `ref("TS_AUTHKEY")` renders `"$TS_AUTHKEY"` (double-quoted so an empty or
 * whitespace-containing value still arrives as exactly one argument).
 */
export const ref = (envVar: string): string => `"$${envVar}"`;

/**
 * PowerShell quoting, for Windows backends.
 *
 * Windows needs its own quoter and cannot reuse {@link quote}: Alchemy's
 * `shell: true` runs `cmd.exe` on Windows, where `'` is not a quote
 * character at all and `%VAR%` still expands inside `"` — so POSIX
 * single-quoting is not merely suboptimal there, it is wrong in a way that
 * silently passes literal quote characters through as part of the argument.
 *
 * Windows backends therefore set `shell: "powershell.exe"` explicitly rather
 * than `shell: true`, and quote with this. In PowerShell a single-quoted
 * string is fully literal, and an embedded `'` is escaped by doubling it.
 *
 * Unlike {@link quote}, this quotes **unconditionally** rather than leaving
 * shell-safe words bare. What is safe bare depends on position in PowerShell,
 * not just on the characters: in argument position `/opt/mytool` is a string,
 * but in expression position — `$x = /opt/mytool` — it parses as a command
 * invocation and fails. A quoting function cannot see which position its
 * result will land in, so the only correct answer is to always quote.
 */
export const quotePwsh = (arg: string): string => `'${arg.replaceAll("'", "''")}'`;

/** Builds a `shell: "powershell.exe"`-safe command string from an argv array. */
export const pwsh = (...argv: readonly string[]): ShellCommand =>
  asShellCommand(argv.map(quotePwsh).join(" "));

/** References an environment variable in PowerShell: `$env:NAME`. */
export const refPwsh = (envVar: string): string => `$env:${envVar}`;

/**
 * The explicit escape hatch for the two legitimate cases where a command is
 * not built from {@link sh}/{@link pwsh} argv quoting:
 *
 * - `Machine.Exec` runs an operator-authored shell command by design — that
 *   is its entire purpose, not a bug to route around.
 * - `Ai.McpServer` launches a user-named binary with user-supplied arguments
 *   that are themselves the configuration being installed, not values being
 *   interpolated into a fixed command shape.
 *
 * Both are correct today and must stay possible. What was missing is that
 * they had to say so: before `ShellCommand` existed, a raw template-literal
 * command and one of these two deliberate cases were typed identically, so
 * the accidental interpolation this repo actually shipped (a prop spliced
 * into a command later written into a shell rc file) compiled without
 * comment. `reason` is required so every call site names, at the call site,
 * which of these it is — it is never read at runtime and does not affect the
 * resulting command; the requirement to supply it is the entire mechanism.
 */
export const unsafeRaw = (command: string, reason: string): ShellCommand => {
  void reason;
  return asShellCommand(command);
};
