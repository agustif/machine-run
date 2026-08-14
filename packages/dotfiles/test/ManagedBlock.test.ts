import { MachinePathsLive } from "@machine-run/core";
import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import {
  beginMarker,
  endMarker,
  makeManagedBlockReconciler,
  ManagedBlockFileUnreadable,
  readBlock,
  renderFile,
  type ManagedBlockProps,
} from "../src/ManagedBlock.ts";

const layer = Layer.mergeAll(MachinePathsLive(), NodeCrypto.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const applyCtx = {
  exec: () => Effect.die("not used"),
  snapshot: () => Effect.succeed(undefined),
};
const observeCtx = { exec: () => Effect.die("not used") };

/**
 * Unwraps a render that is expected to succeed, throwing the real
 * `ManagedBlockMalformed` tagged error — it already carries its own
 * `message` — rather than wrapping it in a generic `Error`.
 */
const render = (
  existing: string,
  marker: string,
  content: string,
  options?: Parameters<typeof renderFile>[3],
): string => Result.getOrThrow(renderFile(existing, marker, content, options));

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

/**
 * The corruption these two guards close.
 *
 * A managed region is delimited by literal marker lines, so content carrying
 * one of those lines makes the region's own boundaries ambiguous. Left
 * unguarded it is silent and destructive: the next read finds the marker
 * inside the content, treats it as the edge, and the splice that follows
 * writes over everything up to it — leaving the real END orphaned in a file
 * whose other lines this tool does not own.
 */
it("refuses content carrying this region's own END marker", () => {
  const result = renderFile("", "shell-path", `echo '${endMarker("shell-path")}'`);
  expect(Result.isFailure(result)).toBe(true);
});

it("refuses content carrying this region's own BEGIN marker", () => {
  const result = renderFile("", "shell-path", `echo '${beginMarker("shell-path")}'`);
  expect(Result.isFailure(result)).toBe(true);
});

it("allows content mentioning a different region's marker", () => {
  // Only this region's own markers are ambiguous. A file may legitimately
  // talk about another one.
  const result = renderFile("", "shell-path", `echo '${endMarker("other-block")}'`);
  expect(Result.isSuccess(result)).toBe(true);
});

it("refuses to splice a file that already carries a duplicated marker", () => {
  // Whoever produced it — a write predating the guard above, a hand edit, or
  // two resources sharing one marker — the first pair cannot be chosen
  // safely, because whatever sits between the others would be discarded.
  const begin = beginMarker("shell-path");
  const end = endMarker("shell-path");
  const corrupted = [begin, "export A=1", end, "", begin, "export B=2", end, ""].join("\n");

  const result = renderFile(corrupted, "shell-path", "export A=1");
  expect(Result.isFailure(result)).toBe(true);
});

it("still replaces a single well-formed region in place", () => {
  // The guards must not make the ordinary case stricter.
  const begin = beginMarker("shell-path");
  const end = endMarker("shell-path");
  const existing = [
    "# hand-written above",
    begin,
    "export OLD=1",
    end,
    "# hand-written below",
    "",
  ].join("\n");

  const result = renderFile(existing, "shell-path", "export NEW=1");
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isSuccess(result)) {
    expect(result.success).toContain("export NEW=1");
    expect(result.success).not.toContain("export OLD=1");
    expect(result.success).toContain("# hand-written above");
    expect(result.success).toContain("# hand-written below");
  }
});

// ---------------------------------------------------------------------------
// CRLF content — a Windows `.gitconfig`/`.ssh/config` routinely carries
// `\r\n`. Before the fix, `normalize`'s `content.replace(/\n+$/, "")` left a
// trailing `\r` on the extracted region, and compared a CRLF region's
// internal `\r\n`s against `props.content`'s plain `\n`s byte-for-byte — both
// meant the region's hash could never equal `desired`'s, so every run saw
// drift and rewrote the file, forever.
// ---------------------------------------------------------------------------

it("readBlock reads back exactly the region's content from a CRLF file, with no stray \\r", () => {
  const file =
    "# hand-written\r\n# machine-run:example BEGIN\r\nline one\r\nline two\r\n# machine-run:example END\r\n# trailer\r\n";
  expect(readBlock(file, "example")).toBe("line one\nline two");
});

it("renderFile replacing a region in a CRLF file reports no drift on the very next read", () => {
  const existing =
    "# hand-written\r\n# machine-run:example BEGIN\r\nold content\r\n# machine-run:example END\r\n";
  const result = renderFile(existing, "example", "old content");
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isSuccess(result)) {
    // The load-bearing assertion: before the fix, the region read back from
    // the rendered file would still carry a `\r` (or otherwise fail to equal
    // the canonical form of `props.content`), so a second `renderFile` call
    // asked to write the *same* content would still see something to change.
    expect(readBlock(result.success, "example")).toBe("old content");
  }
});

it("renderFile preserves a CRLF file's line endings, including inside a multi-line region", () => {
  const existing = "# hand-written\r\n";
  const withRegion = render(existing, "example", "line one\nline two");
  expect(withRegion).toBe(
    "# hand-written\r\n# machine-run:example BEGIN\r\nline one\r\nline two\r\n# machine-run:example END\r\n",
  );
});

it.effect("CRLF file: the reconciler reports no drift after writing the same content twice", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeManagedBlockReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, ".gitconfig");

    yield* fs.writeFileString(target, "[user]\r\n\temail = a@example.com\r\n");

    const props: ManagedBlockProps = {
      path: target,
      marker: "persona",
      content: "[includeIf]\n  path = personal.gitconfig",
    };
    const desired = yield* reconciler.desired(props);
    yield* reconciler.apply({ props, observed: Option.none(), desired }, applyCtx);

    // Before the fix: `observe`'s hash of the CRLF-extracted region never
    // equalled `desired`'s hash of the plain-LF `props.content`, so this
    // reports drift even though nothing changed since the write above.
    const observed = yield* reconciler.observe(props, observeCtx);
    expect(Option.isSome(observed)).toBe(true);
    expect(reconciler.matches(Option.getOrThrow(observed), desired)).toBe(true);
  }).pipe(Effect.provide(layer)),
);

/**
 * `~/.zshrc`, `~/.gitconfig`, `~/.ssh/config` — the files `ManagedBlock`
 * exists for — carry substantial hand-written content this tool does not
 * own. A permission change on one of them must never be mistaken for "the
 * file has nothing in it yet" (MUST_CLEANUP.md 0.2).
 *
 * `0o200` (write-only, no read) rather than the `chmod 0000`-on-a-directory
 * technique used elsewhere in this suite: that would also block the write
 * this test needs to succeed in order to prove the file survives, and real
 * permission drift can easily leave write access intact while removing read
 * access (a stricter ACL, a `chattr`-style flag, a mid-flight `chmod`).
 */
it.effect(
  "observe raises ManagedBlockFileUnreadable, not absence, when the file cannot be read",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeManagedBlockReconciler;
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = path.join(dir, ".zshrc");

      yield* fs.writeFileString(target, "# hand-written setup\nexport FOO=bar\n");
      yield* fs.chmod(target, 0o200);

      // Restored with `Effect.ensuring` rather than `finally`, so it still runs
      // if the assertion fails or the fiber is interrupted.
      const failure = yield* reconciler
        .observe({ path: target, marker: "example", content: "export A=1" }, observeCtx)
        .pipe(
          Effect.flip,
          Effect.ensuring(fs.chmod(target, 0o644).pipe(Effect.orElseSucceed(() => undefined))),
        );

      expect(failure).toBeInstanceOf(ManagedBlockFileUnreadable);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "apply raises ManagedBlockFileUnreadable instead of writing the marker block over content it could not read",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeManagedBlockReconciler;
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = path.join(dir, ".zshrc");

      const original = "# hand-written setup, not managed by this tool\nexport FOO=bar\n";
      yield* fs.writeFileString(target, original);
      yield* fs.chmod(target, 0o200);

      const props: ManagedBlockProps = { path: target, marker: "example", content: "export A=1" };
      const desired = yield* reconciler.desired(props);

      const failure = yield* reconciler
        .apply({ props, observed: Option.none(), desired }, applyCtx)
        .pipe(
          Effect.flip,
          Effect.ensuring(fs.chmod(target, 0o644).pipe(Effect.orElseSucceed(() => undefined))),
        );
      expect(failure).toBeInstanceOf(ManagedBlockFileUnreadable);

      // The load-bearing assertion: without the fix, the unreadable content
      // is silently treated as "", `renderFile` treats the file as empty, and
      // the marker block is written straight over the hand-written original
      // — permanently, since `write`-only permission means the write itself
      // succeeds even though the read that should have preceded it did not.
      expect(yield* fs.readFileString(target)).toBe(original);
    }).pipe(Effect.provide(layer)),
);
