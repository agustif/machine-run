/**
 * Shared line-parsing helpers for package-manager stdout.
 *
 * Backends parse installed-package lists out of CLI output, where a blank or
 * unexpectedly-shaped line is normal. These helpers keep that handling in one
 * place and guarantee a `string[]`: indexing a split line yields
 * `string | undefined`, and letting an `undefined` reach the installed-set
 * corrupts membership tests without failing anything.
 */

/** Non-empty, whitespace-trimmed lines. */
export const lines = (stdout: string): string[] =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/**
 * The first whitespace-delimited token of each line, skipping lines that
 * have none. Never yields `undefined`.
 */
export const firstTokens = (candidates: readonly string[]): string[] => {
  const out: string[] = [];
  for (const line of candidates) {
    const token = line.split(/\s+/)[0];
    if (token !== undefined && token.length > 0) out.push(token);
  }
  return out;
};
