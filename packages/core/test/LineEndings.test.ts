import { expect, it } from "@effect/vitest";
import { detectLineEnding, joinLines, LineEndingChars, splitLines } from "../src/LineEndings.ts";

// ---------------------------------------------------------------------------
// detectLineEnding
// ---------------------------------------------------------------------------

it("detectLineEnding reports lf for an ordinary LF file", () => {
  expect(detectLineEnding("a\nb\nc\n")).toBe("lf");
});

it("detectLineEnding reports crlf for an ordinary CRLF file", () => {
  expect(detectLineEnding("a\r\nb\r\nc\r\n")).toBe("crlf");
});

it("detectLineEnding reports lf for empty content — nothing to preserve", () => {
  expect(detectLineEnding("")).toBe("lf");
});

it("detectLineEnding reports lf for a single line with no trailing terminator at all", () => {
  expect(detectLineEnding("just one line, no newline")).toBe("lf");
});

it("detectLineEnding reports the majority convention for mixed content", () => {
  expect(detectLineEnding("a\r\nb\r\nc\n")).toBe("crlf");
  expect(detectLineEnding("a\nb\nc\r\n")).toBe("lf");
});

it("detectLineEnding breaks an exact tie toward lf", () => {
  expect(detectLineEnding("a\r\nb\n")).toBe("lf");
});

// ---------------------------------------------------------------------------
// splitLines
// ---------------------------------------------------------------------------

it("splitLines splits an LF file and drops exactly one trailing terminator", () => {
  expect(splitLines("a\nb\nc\n")).toEqual(["a", "b", "c"]);
});

it("splitLines splits a CRLF file without leaving a trailing \\r on any line", () => {
  // This is the exact bug this module exists to prevent: a naive
  // `content.split("\n")` leaves "a\r", "b\r", "c\r" here instead.
  expect(splitLines("a\r\nb\r\nc\r\n")).toEqual(["a", "b", "c"]);
});

it("splitLines handles content with no trailing terminator", () => {
  expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
});

it("splitLines returns an empty array for empty content", () => {
  expect(splitLines("")).toEqual([]);
});

it("splitLines returns the content itself as the only line when it has no newline", () => {
  expect(splitLines("no newline here")).toEqual(["no newline here"]);
});

it("splitLines is CRLF/LF-mix tolerant, splitting on either within the same content", () => {
  expect(splitLines("a\r\nb\nc")).toEqual(["a", "b", "c"]);
});

// ---------------------------------------------------------------------------
// joinLines
// ---------------------------------------------------------------------------

it("joinLines terminates every line, including the last, with lf", () => {
  expect(joinLines(["a", "b", "c"], "lf")).toBe("a\nb\nc\n");
});

it("joinLines terminates every line, including the last, with crlf", () => {
  expect(joinLines(["a", "b", "c"], "crlf")).toBe("a\r\nb\r\nc\r\n");
});

it("joinLines returns empty content for zero lines", () => {
  expect(joinLines([], "lf")).toBe("");
  expect(joinLines([], "crlf")).toBe("");
});

it("splitLines and joinLines round-trip for both conventions", () => {
  const lf = "one\ntwo\nthree\n";
  expect(joinLines(splitLines(lf), "lf")).toBe(lf);

  const crlf = "one\r\ntwo\r\nthree\r\n";
  expect(joinLines(splitLines(crlf), "crlf")).toBe(crlf);
});

it("LineEndingChars carries the literal separator for each LineEnding", () => {
  expect(LineEndingChars.lf).toBe("\n");
  expect(LineEndingChars.crlf).toBe("\r\n");
});
