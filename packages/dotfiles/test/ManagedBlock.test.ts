import { NodeContext } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { renderFile } from "../src/ManagedBlock.ts";

it("inserts a new marked block into an empty file", () => {
  expect(renderFile("", "example", "line one")).toBe(
    "# machine-run:example BEGIN\nline one\n# machine-run:example END\n",
  );
});

it("appends a marked block after existing hand-written content", () => {
  const result = renderFile("# hand-written\nexport FOO=bar\n", "example", "export A=1");
  expect(result).toBe(
    "# hand-written\nexport FOO=bar\n# machine-run:example BEGIN\nexport A=1\n# machine-run:example END\n",
  );
});

it("replaces only the marked block on a second render, leaving the rest untouched", () => {
  const first = renderFile("# hand-written\n", "example", "export A=1");
  const second = renderFile(first, "example", "export A=2");
  expect(second).toContain("# hand-written");
  expect(second).toContain("export A=2");
  expect(second).not.toContain("export A=1");
  expect(second.match(/BEGIN/g)?.length).toBe(1);
});

it.effect("File resource round-trips through a real temp directory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, ".zshrc");
    yield* fs.writeFileString(target, "# hand-written setup\n");

    const updated = renderFile(yield* fs.readFileString(target), "example", 'export MACHINE_RUN="1"');
    yield* fs.writeFileString(target, updated);

    const result = yield* fs.readFileString(target);
    expect(result).toContain("# hand-written setup");
    expect(result).toContain("# machine-run:example BEGIN");
    expect(result).toContain('export MACHINE_RUN="1"');
  }).pipe(Effect.provide(NodeContext.layer)),
);
