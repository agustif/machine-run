import { MachinePathsLive, PlatformLive } from "@machine-run/core";
import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { platform as nodePlatform } from "node:os";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import {
  LineInFileMalformed,
  LineInFileUnreadable,
  makeLineInFileReconciler,
  readLine,
  removeLine,
  renderLine,
  type LineInFileProps,
} from "../src/LineInFile.ts";

const layer = Layer.mergeAll(MachinePathsLive(), PlatformLive(), NodeCrypto.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const applyCtx = {
  exec: () => Effect.die("not used"),
  snapshot: () => Effect.succeed(undefined),
};
const observeCtx = { exec: () => Effect.die("not used") };

// Windows cannot express a write-only file through chmod; ACL semantics are
// covered by the Windows permission-domain tests instead.
const POSIX_PERMISSIONS_AVAILABLE = nodePlatform() !== "win32";

/**
 * Unwraps a render that is expected to succeed, throwing the real
 * `LineInFileMalformed` tagged error — it already carries its own
 * `message` — rather than wrapping it in a generic `Error`.
 */
const render = (
  existing: string,
  match: string,
  line: string,
  options?: Parameters<typeof renderLine>[3],
) => Result.getOrThrow(renderLine(existing, match, line, options));

it("inserts a new line at the end of an empty file", () => {
  expect(render("", "^export FOO=", "export FOO=bar")).toBe("export FOO=bar\n");
});

it("appends the new line after existing hand-written content", () => {
  expect(render("# hand-written\nexport OTHER=1\n", "^export FOO=", "export FOO=bar")).toBe(
    "# hand-written\nexport OTHER=1\nexport FOO=bar\n",
  );
});

it("prepends when asked", () => {
  expect(render("existing line\n", "^first", "first line", { position: "prepend" })).toBe(
    "first line\nexisting line\n",
  );
});

it("replaces the one matching line in place, leaving everything else untouched", () => {
  const first = render("# comment\nexport FOO=old\n# trailer\n", "^export FOO=", "export FOO=new");
  expect(first).toBe("# comment\nexport FOO=new\n# trailer\n");
});

it("reads back exactly the line that was written, so drift is detectable", () => {
  const file = render("", "^127\\.0\\.0\\.1", "127.0.0.1 example.local");
  const found = readLine(file, "^127\\.0\\.0\\.1");
  expect(Result.isSuccess(found)).toBe(true);
  if (Result.isSuccess(found)) expect(found.success).toBe("127.0.0.1 example.local");
});

it("reads undefined when no line matches yet", () => {
  const found = readLine("unrelated content\n", "^export FOO=");
  expect(Result.isSuccess(found)).toBe(true);
  if (Result.isSuccess(found)) expect(found.success).toBeUndefined();
});

it("a hand-edited matching line reads back its new text", () => {
  const file = render("", "^export FOO=", "export FOO=1");
  const edited = file.replace("export FOO=1", "export FOO=99");
  const found = readLine(edited, "^export FOO=");
  expect(Result.isSuccess(found)).toBe(true);
  if (Result.isSuccess(found)) expect(found.success).toBe("export FOO=99");
});

/**
 * The corruption this guard closes: with no markers, "the line" is only ever
 * as unambiguous as `match` is. Picking a match arbitrarily (first, last)
 * would silently ignore a duplicate this resource doesn't own.
 */
it("refuses to read when more than one line matches", () => {
  const existing = "export FOO=1\nexport FOO=2\n";
  const found = readLine(existing, "^export FOO=");
  expect(Result.isFailure(found)).toBe(true);
});

it("refuses to render (replace) when more than one line matches", () => {
  const existing = "export FOO=1\nexport FOO=2\n";
  const result = renderLine(existing, "^export FOO=", "export FOO=new");
  expect(Result.isFailure(result)).toBe(true);
});

it("still succeeds rendering a single well-formed match — the guard doesn't make the ordinary case stricter", () => {
  const existing = "export FOO=1\nexport BAR=2\n";
  const result = renderLine(existing, "^export FOO=", "export FOO=new");
  expect(Result.isSuccess(result)).toBe(true);
});

/**
 * The other half of the guard: a `line` that does not itself satisfy `match`
 * could never be found again on a later run, so every apply would insert a
 * fresh duplicate rather than converging.
 */
it("refuses a line that does not itself satisfy match", () => {
  const result = renderLine("", "^export FOO=", "export BAR=1");
  expect(Result.isFailure(result)).toBe(true);
});

// ---------------------------------------------------------------------------
// CRLF content — `/etc/hosts`, `~/.zshrc` and the like frequently carry `\r\n`
// on Windows. A naive `content.split("\n")` leaves a trailing `\r` on every
// line; that `\r` survives into whatever `match` was anchored with `$`, so a
// line that is genuinely already there reads as "not found" and gets a
// duplicate appended on every single run — the most damaging of the three
// bugs this module's fix addresses (see the task's report for the other two).
// ---------------------------------------------------------------------------

it("readLine finds an existing CRLF line despite the trailing \\r a naive split would leave", () => {
  const existing = "# header\r\n127.0.0.1 example.local\r\n";
  // Anchored with `$`, as a recipe author would to identify the line
  // unambiguously — exactly the pattern a stray trailing `\r` defeats.
  const found = readLine(existing, "^127\\.0\\.0\\.1 example\\.local$");
  expect(Result.isSuccess(found)).toBe(true);
  if (Result.isSuccess(found)) expect(found.success).toBe("127.0.0.1 example.local");
});

it("renderLine preserves an existing CRLF file's line endings when replacing the owned line", () => {
  const existing = "# header\r\n127.0.0.1 old.local\r\n# trailer\r\n";
  const result = renderLine(existing, "^127\\.0\\.0\\.1 ", "127.0.0.1 new.local");
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isSuccess(result)) {
    expect(result.success).toBe("# header\r\n127.0.0.1 new.local\r\n# trailer\r\n");
  }
});

it.effect(
  "CRLF file: an already-present, $-anchored line is recognised — not duplicated — across repeated applies",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeLineInFileReconciler;
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = path.join(dir, "hosts");

      // A CRLF file, as a Windows-authored `/etc/hosts` would be.
      yield* fs.writeFileString(target, "# header\r\n127.0.0.1 example.local\r\n");

      const props: LineInFileProps = {
        path: target,
        match: "^127\\.0\\.0\\.1 example\\.local$",
        line: "127.0.0.1 example.local",
      };
      const desired = yield* reconciler.desired(props);
      const observed = yield* reconciler.observe(props, observeCtx);

      // The load-bearing assertion: before the fix, a naive `content.split("\n")`
      // leaves this line as `"127.0.0.1 example.local\r"`, which the
      // `$`-anchored `match` never recognises, so `observe` reports "no line
      // yet" for a line that is genuinely already there.
      expect(Option.isSome(observed)).toBe(true);
      expect(reconciler.matches(Option.getOrThrow(observed), desired)).toBe(true);

      yield* reconciler.apply({ props, observed, desired }, applyCtx);

      const content = yield* fs.readFileString(target);
      const occurrences = content.match(/127\.0\.0\.1 example\.local/g)?.length ?? 0;
      // Before the fix, `apply` treats the existing line as absent (the same
      // trailing-`\r` bug) and appends a second copy every time it runs —
      // the duplicate-on-every-run failure this test exists to catch.
      expect(occurrences).toBe(1);
      // And the file's pre-existing CRLF convention survives the write.
      expect(content).toBe("# header\r\n127.0.0.1 example.local\r\n");
    }).pipe(Effect.provide(layer)),
);

it.effect("apply inserts the line, and a second apply with the same props is a no-op", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeLineInFileReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "hosts");

    const props: LineInFileProps = {
      path: target,
      match: "^127\\.0\\.0\\.1 ",
      line: "127.0.0.1 example.local",
    };
    const desired = yield* reconciler.desired(props);
    yield* reconciler.apply({ props, observed: Option.none(), desired }, applyCtx);

    expect(yield* fs.readFileString(target)).toBe("127.0.0.1 example.local\n");

    const observed = yield* reconciler.observe(props, observeCtx);
    expect(Option.isSome(observed)).toBe(true);
    expect(reconciler.matches(Option.getOrThrow(observed), desired)).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("live drift: a hand-edit to the owned line is detected on the next observe", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeLineInFileReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "hosts");

    const props: LineInFileProps = {
      path: target,
      match: "^127\\.0\\.0\\.1 ",
      line: "127.0.0.1 example.local",
    };
    const desired = yield* reconciler.desired(props);
    yield* reconciler.apply({ props, observed: Option.none(), desired }, applyCtx);

    yield* fs.writeFileString(target, "127.0.0.1 hand-edited.local\n");

    const observed = yield* reconciler.observe(props, observeCtx);
    expect(Option.isSome(observed)).toBe(true);
    expect(reconciler.matches(Option.getOrThrow(observed), desired)).toBe(false);
  }).pipe(Effect.provide(layer)),
);

it.effect("a second call replaces the line rather than appending a duplicate", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeLineInFileReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "hosts");

    const props: LineInFileProps = {
      path: target,
      match: "^127\\.0\\.0\\.1 ",
      line: "127.0.0.1 example.local",
    };
    const desired = yield* reconciler.desired(props);
    yield* reconciler.apply({ props, observed: Option.none(), desired }, applyCtx);

    const props2: LineInFileProps = { ...props, line: "127.0.0.1 renamed.local" };
    const desired2 = yield* reconciler.desired(props2);
    yield* reconciler.apply(
      { props: props2, observed: yield* reconciler.observe(props2, observeCtx), desired: desired2 },
      applyCtx,
    );

    const content = yield* fs.readFileString(target);
    expect(content).toBe("127.0.0.1 renamed.local\n");
    expect(content.match(/127\.0\.0\.1/g)?.length).toBe(1);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "observe fails with LineInFileMalformed, not a guessed pick, when more than one line matches",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeLineInFileReconciler;
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = path.join(dir, "hosts");

      yield* fs.writeFileString(target, "127.0.0.1 one.local\n127.0.0.1 two.local\n");

      const props: LineInFileProps = {
        path: target,
        match: "^127\\.0\\.0\\.1 ",
        line: "127.0.0.1 example.local",
      };
      const error = yield* reconciler.observe(props, observeCtx).pipe(Effect.flip);
      expect(error).toBeInstanceOf(LineInFileMalformed);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "desired fails with LineInFileMalformed when the desired line does not satisfy match",
  () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const reconciler = yield* makeLineInFileReconciler;

      const props: LineInFileProps = {
        path: path.join("/nonexistent", "hosts"),
        match: "^127\\.0\\.0\\.1 ",
        line: "192.168.1.1 wrong-prefix",
      };
      const error = yield* reconciler.desired(props).pipe(Effect.flip);
      expect(error).toBeInstanceOf(LineInFileMalformed);
    }).pipe(Effect.provide(layer)),
);

it.effect("apply fails with LineInFileMalformed rather than writing over an ambiguous match", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeLineInFileReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "hosts");

    yield* fs.writeFileString(target, "127.0.0.1 one.local\n127.0.0.1 two.local\n");

    const props: LineInFileProps = {
      path: target,
      match: "^127\\.0\\.0\\.1 ",
      line: "127.0.0.1 example.local",
    };
    const desiredState = yield* reconciler.desired(props);
    const error = yield* reconciler
      .apply({ props, observed: Option.none(), desired: desiredState }, applyCtx)
      .pipe(Effect.flip);
    expect(error).toBeInstanceOf(LineInFileMalformed);

    // The file's original two lines are untouched: an ambiguous match refuses
    // to guess, rather than clobbering one of the two candidates.
    expect(yield* fs.readFileString(target)).toBe("127.0.0.1 one.local\n127.0.0.1 two.local\n");
  }).pipe(Effect.provide(layer)),
);

/**
 * `/etc/hosts`, a lone `export` in `~/.zshrc` — the files `LineInFile` exists
 * for — carry hand-written lines this tool does not own. A permission change
 * must never be mistaken for "the file has nothing in it yet"
 * (MUST_CLEANUP.md 0.3).
 *
 * `0o200` (write-only, no read) rather than the `chmod 0000`-on-a-directory
 * technique used elsewhere in this suite: that would also block the write
 * this test needs to succeed in order to prove the file survives, and real
 * permission drift can easily leave write access intact while removing read
 * access.
 */
it.effect.skipIf(!POSIX_PERMISSIONS_AVAILABLE)(
  "observe raises LineInFileUnreadable, not absence, when the file cannot be read",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeLineInFileReconciler;
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = path.join(dir, "hosts");

      yield* fs.writeFileString(target, "127.0.0.1 example.local\n");
      yield* fs.chmod(target, 0o200);

      // Restored with `Effect.ensuring` rather than `finally`, so it still runs
      // if the assertion fails or the fiber is interrupted.
      const failure = yield* reconciler
        .observe(
          { path: target, match: "^127\\.0\\.0\\.1 ", line: "127.0.0.1 example.local" },
          observeCtx,
        )
        .pipe(
          Effect.flip,
          Effect.ensuring(fs.chmod(target, 0o644).pipe(Effect.orElseSucceed(() => undefined))),
        );

      expect(failure).toBeInstanceOf(LineInFileUnreadable);
    }).pipe(Effect.provide(layer)),
);

it.effect.skipIf(!POSIX_PERMISSIONS_AVAILABLE)(
  "apply raises LineInFileUnreadable instead of inserting a line into content it could not read",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeLineInFileReconciler;
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = path.join(dir, "hosts");

      const original = "127.0.0.1 already-here.local\n# hand-written comment\n";
      yield* fs.writeFileString(target, original);
      yield* fs.chmod(target, 0o200);

      const props: LineInFileProps = {
        path: target,
        match: "^10\\.0\\.0\\.1 ",
        line: "10.0.0.1 new-entry.local",
      };
      const desired = yield* reconciler.desired(props);

      const failure = yield* reconciler
        .apply({ props, observed: Option.none(), desired }, applyCtx)
        .pipe(
          Effect.flip,
          Effect.ensuring(fs.chmod(target, 0o644).pipe(Effect.orElseSucceed(() => undefined))),
        );
      expect(failure).toBeInstanceOf(LineInFileUnreadable);

      // The load-bearing assertion: without the fix, the unreadable content
      // is silently treated as "", `renderLine` treats the file as empty, and
      // the new line is inserted as if it were the only content — discarding
      // the original lines, which the write-only permission would still
      // allow it to overwrite.
      expect(yield* fs.readFileString(target)).toBe(original);
    }).pipe(Effect.provide(layer)),
);

it("removeLine deletes just the one matching line, leaving the rest untouched", () => {
  const existing = "# comment\nexport FOO=1\n# trailer\n";
  const removed = Result.getOrThrow(removeLine(existing, "^export FOO="));
  expect(removed).toBe("# comment\n# trailer\n");
});

it("removeLine is a no-op when no line matches", () => {
  const existing = "unrelated content\n";
  expect(Result.getOrThrow(removeLine(existing, "^export FOO="))).toBe(existing);
});

it("removeLine refuses when more than one line matches, rather than guessing", () => {
  const existing = "export FOO=1\nexport FOO=2\n";
  expect(Result.isFailure(removeLine(existing, "^export FOO="))).toBe(true);
});

it.effect("drift is empty exactly when matches is true, and names path, match and content", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeLineInFileReconciler;
    const drift = reconciler.drift;
    if (drift === undefined) return yield* Effect.die("expected drift to be defined");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "hosts");

    const props: LineInFileProps = {
      path: target,
      match: "^127\\.0\\.0\\.1 ",
      line: "127.0.0.1 example.local",
    };
    const desired = yield* reconciler.desired(props);
    yield* reconciler.apply({ props, observed: Option.none(), desired }, applyCtx);
    const observed = Option.getOrThrow(yield* reconciler.observe(props, observeCtx));

    expect(reconciler.matches(observed, desired)).toBe(true);
    expect(drift(observed, desired)).toEqual([]);

    const changedProps: LineInFileProps = { ...props, line: "127.0.0.1 renamed.local" };
    const changedDesired = yield* reconciler.desired(changedProps);
    expect(reconciler.matches(observed, changedDesired)).toBe(false);
    expect(drift(observed, changedDesired).map((f) => f.field)).toEqual(["content"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("unapply removes just this resource's own line, leaving the rest of the file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeLineInFileReconciler;
    const unapply = reconciler.unapply;
    if (unapply === undefined) return yield* Effect.die("expected unapply to be defined");
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "hosts");

    yield* fs.writeFileString(target, "# comment\n# trailer\n");

    const props: LineInFileProps = {
      path: target,
      match: "^127\\.0\\.0\\.1 ",
      line: "127.0.0.1 example.local",
    };
    const desired = yield* reconciler.desired(props);
    yield* reconciler.apply({ props, observed: Option.none(), desired }, applyCtx);

    const observed = Option.getOrThrow(yield* reconciler.observe(props, observeCtx));
    yield* unapply({ props, observed, recorded: desired }, applyCtx);

    const content = yield* fs.readFileString(target);
    expect(content).toContain("# comment");
    expect(content).toContain("# trailer");
    expect(content).not.toContain("127.0.0.1");
  }).pipe(Effect.provide(layer)),
);
