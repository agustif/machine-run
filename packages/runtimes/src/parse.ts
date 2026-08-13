/**
 * Shared line-parsing helpers for runtime-manager stdout — the same shape as
 * `system-packages`'s `parse.ts`, duplicated rather than imported: it is six
 * lines of pure string handling, not a real cross-package dependency.
 */

/** Non-empty, whitespace-trimmed lines. */
export const lines = (stdout: string): string[] =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
