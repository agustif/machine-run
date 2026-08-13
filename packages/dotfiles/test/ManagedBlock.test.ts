import { expect, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { readBlock, renderFile } from "../src/ManagedBlock.ts";

/** Unwraps a render that is expected to succeed. */
const render = (
  existing: string,
  marker: string,
  content: string,
  options?: Parameters<typeof renderFile>[3],
): string => {
  const result = renderFile(existing, marker, content, options);
  if (Result.isFailure(result)) {
    throw new Error(`expected a successful render, got: ${result.failure.detail}`);
  }
  return result.success;
};

it("inserts a region into an empty file", () => {
  expect(render("", "example", "line one")).toBe(
    "# machine-run:example BEGIN\nline one\n# machine-run:example END\n",
  );
});

it("appends after existing hand-written content", () => {
  expect(render("# hand-written\nexport FOO=bar\n", "example", "export A=1")).toBe(
    "# hand-written\nexport FOO=bar\n# machine-run:example BEGIN\nexport A=1\n# machine-run:example END\n",
  );
});

it("separates the region when the file does not end in a newline", () => {
  expect(render("no-trailing-newline", "example", "x")).toBe(
    "no-trailing-newline\n# machine-run:example BEGIN\nx\n# machine-run:example END\n",
  );
});

it("prepends when asked, so a later catch-all stanza cannot shadow it", () => {
  // ssh_config takes the first value it sees for a keyword, so a region added
  // to a file that already contains `Host *` has to go above it.
  const existing = "Host *\n  ForwardAgent yes\n";
  expect(render(existing, "exe", "Host exe.dev", { position: "prepend" })).toBe(
    "# machine-run:exe BEGIN\nHost exe.dev\n# machine-run:exe END\n" + existing,
  );
});

it("replaces only the region, leaving surrounding content untouched", () => {
  const first = render("# hand-written\n", "example", "export A=1");
  const second = render(first, "example", "export A=2");
  expect(second).toContain("# hand-written");
  expect(second).toContain("export A=2");
  expect(second).not.toContain("export A=1");
  expect(second.match(/BEGIN/g)?.length).toBe(1);
});

it("leaves other regions in the same file alone", () => {
  const withA = render("", "a", "first");
  const withBoth = render(withA, "b", "second");
  const updated = render(withBoth, "a", "first-updated");
  expect(updated).toContain("first-updated");
  expect(updated).toContain("second");
  expect(updated).not.toContain("\nfirst\n");
});

it("honours a non-default comment prefix", () => {
  expect(render("", "example", "x = 1", { commentPrefix: "//" })).toBe(
    "// machine-run:example BEGIN\nx = 1\n// machine-run:example END\n",
  );
});

it("reports a BEGIN with no matching END instead of corrupting the file", () => {
  const result = renderFile("# machine-run:example BEGIN\nstray\n", "example", "x");
  expect(Result.isFailure(result)).toBe(true);
});

it("reports an END that precedes its BEGIN instead of corrupting the file", () => {
  const inverted = "# machine-run:example END\nbody\n# machine-run:example BEGIN\n";
  const result = renderFile(inverted, "example", "x");
  expect(Result.isFailure(result)).toBe(true);
});

it("reads back exactly what was written, so drift is detectable", () => {
  const content = 'export MACHINE_RUN="1"';
  const file = render("# hand-written setup\n", "example", content);
  expect(readBlock(file, "example")).toBe(content);
});

it("reads nothing for a region that is not present", () => {
  expect(readBlock("# unrelated\n", "example")).toBeUndefined();
});

it("reads nothing when the region is unterminated", () => {
  expect(readBlock("# machine-run:example BEGIN\nbody\n", "example")).toBeUndefined();
});

it("a hand-edited region no longer matches what was written", () => {
  const file = render("", "example", "export A=1");
  const edited = file.replace("export A=1", "export A=99");
  expect(readBlock(edited, "example")).toBe("export A=99");
});
