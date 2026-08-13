import { MachinePathsLive } from "@machine-run/core";
import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import {
  LineInFileMalformed,
  makeLineInFileReconciler,
  readLine,
  renderLine,
  type LineInFileProps,
} from "../src/LineInFile.ts";

const layer = Layer.mergeAll(MachinePathsLive(), NodeCrypto.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const applyCtx = {
  exec: () => Effect.die("not used"),
  snapshot: () => Effect.succeed(undefined),
};
const observeCtx = { exec: () => Effect.die("not used") };

/** Unwraps a render that is expected to succeed. */
const render = (existing: string, match: string, line: string, options?: Parameters<typeof renderLine>[3]) => {
  const result = renderLine(existing, match, line, options);
  if (Result.isFailure(result)) {
    throw new Error(`expected a successful render, got: ${result.failure.detail}`);
  }
  return result.success;
};

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
    yield* reconciler.apply({ props, observed: undefined, desired }, applyCtx);

    expect(yield* fs.readFileString(target)).toBe("127.0.0.1 example.local\n");

    const observed = yield* reconciler.observe(props, observeCtx);
    expect(observed).toBeDefined();
    expect(reconciler.matches(observed!, desired)).toBe(true);
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
    yield* reconciler.apply({ props, observed: undefined, desired }, applyCtx);

    yield* fs.writeFileString(target, "127.0.0.1 hand-edited.local\n");

    const observed = yield* reconciler.observe(props, observeCtx);
    expect(observed).toBeDefined();
    expect(reconciler.matches(observed!, desired)).toBe(false);
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
    yield* reconciler.apply({ props, observed: undefined, desired }, applyCtx);

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

it.effect("observe fails with LineInFileMalformed, not a guessed pick, when more than one line matches", () =>
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

it.effect("desired fails with LineInFileMalformed when the desired line does not satisfy match", () =>
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
      .apply({ props, observed: undefined, desired: desiredState }, applyCtx)
      .pipe(Effect.flip);
    expect(error).toBeInstanceOf(LineInFileMalformed);

    // The file's original two lines are untouched: an ambiguous match refuses
    // to guess, rather than clobbering one of the two candidates.
    expect(yield* fs.readFileString(target)).toBe("127.0.0.1 one.local\n127.0.0.1 two.local\n");
  }).pipe(Effect.provide(layer)),
);
