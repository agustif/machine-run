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
 */

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
export const sh = (...argv: readonly string[]): string =>
  argv.map(quote).join(" ");

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
export const quotePwsh = (arg: string): string =>
  `'${arg.replaceAll("'", "''")}'`;

/** Builds a `shell: "powershell.exe"`-safe command string from an argv array. */
export const pwsh = (...argv: readonly string[]): string =>
  argv.map(quotePwsh).join(" ");

/** References an environment variable in PowerShell: `$env:NAME`. */
export const refPwsh = (envVar: string): string => `$env:${envVar}`;
