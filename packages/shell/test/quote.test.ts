import { expect, it } from "@effect/vitest";
import { quoteFish, quoteNu } from "../src/quote.ts";

// Fixtures below are real container output, not invented text — see
// docs/shell-notes.md for the exact commands run (fish 3.7.0 and nu 0.114.1,
// both on Ubuntu 24.04 via Docker).

it("quoteFish escapes an embedded single quote the way fish itself expects", () => {
  // Verified in a container: `fish -c "set -gx MY_VAR 'it\'s'; echo $MY_VAR"`
  // printed back exactly `it's` — fish allows a backslash-escaped quote
  // *inside* a single-quoted string, unlike POSIX sh.
  expect(quoteFish("it's")).toBe("'it\\'s'");
});

it("quoteFish escapes a literal backslash so it isn't read as the start of an escape", () => {
  expect(quoteFish("a\\b")).toBe("'a\\\\b'");
});

it("quoteFish leaves shell-metacharacter-free text as a plain single-quoted literal", () => {
  expect(quoteFish("/opt/mytool")).toBe("'/opt/mytool'");
});

it("quoteNu wraps a value in raw-string syntax untouched", () => {
  expect(quoteNu("/opt/mytool")).toBe("r#'/opt/mytool'#");
});

it("quoteNu's raw string survives command substitution, backticks and embedded quotes verbatim", () => {
  // Verified in a container: this exact payload, wrapped the same way, was
  // printed back byte-for-byte by `nu /t.nu` — none of `$(...)`, the
  // backtick or the embedded `"` were reinterpreted.
  const payload = `it's a "test" $(danger) \`backtick\` \\n literal`;
  const rendered = quoteNu(payload);
  expect(rendered).toBe(`r#'${payload}'#`);
});
