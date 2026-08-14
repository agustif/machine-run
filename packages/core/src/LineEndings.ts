import * as Boolean from "effect/Boolean";
import * as Schema from "effect/Schema";

/**
 * The newline convention a text file uses. Closed to exactly the two forms
 * this repo's target platforms actually write — POSIX `\n` and Windows
 * `\r\n` — as a `Schema.Literals` rather than a bare `string`, so "does this
 * file use lf or crlf" is a question the type system can answer, not a fact
 * that lives only in a comment next to whichever regex happened to assume it.
 *
 * A lone `\r` (classic Mac OS 9) is not a member of this union: nothing this
 * repo edits — `.zshrc`, `.gitconfig`, `.ssh/config`, `known_hosts`,
 * `/etc/hosts` — is ever legitimately written in that convention by a tool
 * still in use, so adding a third case would only make every `Match` over
 * `LineEnding` respond to a possibility that can't actually occur.
 *
 * ## The policy this vocabulary exists to enforce
 *
 * **Preserve whatever line ending a file already uses; write `\n` for a file
 * being created from nothing.**
 *
 * The reason is what this whole package is for: machine-run edits files it
 * does not own — `~/.zshrc`, `~/.gitconfig`, `~/.ssh/config`, `/etc/hosts` —
 * and on Windows those files routinely carry CRLF, put there by Notepad, by
 * PowerShell's `Set-Content`, by Windows OpenSSH, by whatever tool the person
 * who owns the machine actually used. Converting a hand-maintained CRLF file
 * to LF because one `ManagedBlock` call happened to touch a region inside it
 * is exactly the "clobber config you don't understand" failure this project
 * exists to avoid (`AGENTS.md` §0, §11) — nobody asked this tool to reformat
 * their file, only to manage one line or one marked region of it.
 *
 * **Why `\n` for a new file, rather than "this machine's own platform
 * default" (which on Windows would be CRLF):**
 *
 * - The content being written is a recipe's ordinary TypeScript string
 *   literal — `props.content`, `props.line` — and a TS/JS source file's own
 *   multi-line template literals are LF internally regardless of what OS
 *   authored them. Writing exactly those bytes on first creation means the
 *   same recipe produces byte-identical output on a fresh macOS machine and a
 *   fresh Windows one, which matters for this project's actual goal: a
 *   recipe is meant to be portable across machines (see `Paths.ts`'s
 *   `MachinePaths` doc comment for the same portability argument applied to
 *   paths). Picking "whatever this OS prefers" would make first-run output
 *   platform-dependent for no benefit.
 * - LF is never the wrong choice to *read*: every tool this repo's resources
 *   touch — OpenSSH (native and Windows-native), git, POSIX shells via WSL or
 *   Git Bash, PowerShell profile scripts — accepts LF-only files without
 *   complaint. The reverse is not true: a POSIX shell sourcing a CRLF script
 *   can fail on the stray `\r` (a shebang line, a backslash line
 *   continuation), and that failure mode is exactly the kind of thing that
 *   surfaces far from its cause. So LF is the universally-safe default for
 *   content nothing has opinions about yet, and CRLF is the special case this
 *   module preserves once something else already chose it.
 * - This mirrors an existing, well-tested precedent rather than inventing
 *   one: git's own `core.autocrlf` stores repository content as LF
 *   internally on every platform and converts only at the working-tree
 *   boundary, for the same reason — LF is the portable canonical form.
 */
export const LineEnding = Schema.Literals(["lf", "crlf"]);
export type LineEnding = typeof LineEnding.Type;

/**
 * The literal separator each {@link LineEnding} writes. Exported alongside
 * {@link joinLines} because a caller splicing raw string content — inserting
 * a rendered region between two slices of an existing file, rather than
 * reassembling the whole file as a line array — needs the bare separator,
 * not a function that also appends one after the last line.
 */
export const LineEndingChars = {
  lf: "\n",
  crlf: "\r\n",
} satisfies Readonly<Record<LineEnding, string>>;

/**
 * What newline convention `content` already uses, so a resource that owns
 * only part of a file — one line, one marked region — can write its own
 * output the same way the rest of the file is written, rather than silently
 * converting content it does not own.
 *
 * ## The rule for the two cases "what does this file use" doesn't answer on
 * its own
 *
 * - **No newline anywhere in `content`** — an empty file, or one that is a
 *   single line with no trailing terminator — has no existing convention to
 *   preserve, so this reports `"lf"`. That is deliberately the same value
 *   {@link joinLines} defaults new content to: a file with nothing in it yet
 *   is exactly a file being created, and this collapses "detect" and
 *   "create-default" into one answer instead of asking every caller to
 *   special-case "the file doesn't exist" separately from "the file exists
 *   but has one line and no terminator" — both are "nothing here to
 *   preserve," so both get the same default.
 * - **Mixed line endings** — real content carries both `\r\n` and bare `\n`,
 *   e.g. a file stitched together from two editors, or one line pasted in
 *   from a different OS — reports whichever ending accounts for the
 *   *majority* of the line breaks actually present. A single outlier line
 *   should not flip the detected convention for a file that is overwhelmingly
 *   one style; counting first-occurrence-only would let exactly one
 *   mis-pasted line decide the whole file's fate. An exact tie reports
 *   `"lf"`, the same bias this module's create-default takes whenever there
 *   is no clear signal either way.
 */
export const detectLineEnding = (content: string): LineEnding => {
  const newlineCount = (content.match(/\n/g) ?? []).length;
  if (newlineCount === 0) return "lf";
  const crlfCount = (content.match(/\r\n/g) ?? []).length;
  return Boolean.match(crlfCount * 2 > newlineCount, {
    onTrue: () => "crlf" as const,
    onFalse: () => "lf" as const,
  });
};

/**
 * Splits `content` into lines, correctly for both `\r\n` and bare `\n` —
 * unlike a raw `content.split("\n")`, which leaves a trailing `\r` on every
 * line of a CRLF file. That stray `\r` is exactly what made
 * `Dotfiles.LineInFile`'s owned-line lookup and `Dotfiles.ManagedBlock`'s
 * region hash never match a CRLF file's actual content (see their call
 * sites), because a `$`-anchored `match` or a byte-for-byte hash comparison
 * both treat `"the line\r"` as different from `"the line"`.
 *
 * Drops exactly one trailing line terminator, the same as the callers this
 * replaces already did for the LF-only case — so `""` and a single
 * terminator-less line both round-trip through {@link joinLines} unchanged,
 * and a file ending in a terminator does not gain a spurious trailing empty
 * line.
 */
export const splitLines = (content: string): readonly string[] => {
  if (content.length === 0) return [];
  const lines = content.split(/\r\n|\n/);
  if (content.endsWith("\n")) return lines.slice(0, -1);
  return lines;
};

/**
 * Joins `lines` back into file content, terminated by `ending`'s separator
 * after every line including the last — the inverse of {@link splitLines} —
 * or into `""` for zero lines, since a file with no lines at all has nothing
 * to terminate.
 */
export const joinLines = (lines: readonly string[], ending: LineEnding): string => {
  if (lines.length === 0) return "";
  const separator = LineEndingChars[ending];
  return `${lines.join(separator)}${separator}`;
};
