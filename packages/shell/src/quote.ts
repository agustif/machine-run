/**
 * Shell-syntax-specific string quoting this package needs beyond
 * `@machine-run/core`'s `Sh` module.
 *
 * `Sh` quotes an argument for a command `CommandExecutor` runs directly —
 * POSIX (`Sh.quote`) or PowerShell (`Sh.quotePwsh`). Both are reused directly
 * by this package's POSIX (`backends/posix.ts`) and `backends/Pwsh.ts`
 * renderers, since the escaping hazard is the same: a value containing `$`,
 * backticks or a quote character must not become code once the rendered line
 * is sourced. Fish and nu have their own string-literal syntax that neither
 * of `Sh`'s two quoters produce correctly, so this module adds exactly those
 * two.
 */

/**
 * Quotes a value for fish's single-quoted string syntax.
 *
 * Verified in a container (fish 3.7.0, Ubuntu 24.04 — see `docs/shell-
 * notes.md`): unlike POSIX `sh`, fish recognises the two-character escapes
 * `\'` and `\\` *inside* a single-quoted string, rather than requiring `sh`'s
 * close-escape-reopen idiom (`Sh.quote`'s `'it'\''s'`). `'it\'s'` is valid
 * fish and evaluates to `it's` — confirmed by running `fish -c "set -gx V
 * 'it\'s'; echo $V"` and reading back `it's`.
 */
export const quoteFish = (value: string): string =>
  `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

/**
 * Wraps a value in nu's raw-string syntax, `r#'...'#`.
 *
 * Verified in a container (nu 0.114.1 — see `docs/shell-notes.md`): unlike a
 * plain single- or double-quoted nu string, a raw string performs no
 * interpolation and no escape processing at all, so `$(...)`, backticks and
 * embedded `'` all survive as literal bytes — confirmed with a value
 * containing all three (`it's a "test" $(danger) \`backtick\` \n literal`)
 * coming back unchanged.
 *
 * The only string this cannot hold is one containing the literal
 * three-character sequence `'#`, and nu's raw-string syntax has no escape for
 * it. None of the values this package renders (directory paths, alias/hook
 * command strings) are expected to contain it; a value that does needs a
 * different nu-side representation this package does not attempt.
 */
export const quoteNu = (value: string): string => `r#'${value}'#`;
