import * as Dotfiles from "@machine-run/dotfiles";
import { inMemoryState } from "alchemy/State";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const { test } = Test.make({
  providers: Dotfiles.providers(),
  state: inMemoryState(),
});

test.provider("inserts a marked block without touching existing content", (stack) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, ".zshrc");
    yield* fs.writeFileString(target, "# hand-written setup\nexport FOO=bar\n");

    yield* stack.deploy(
      Dotfiles.ManagedBlock("example-block", {
        path: target,
        marker: "example",
        content: 'export MACHINE_RUN="1"',
      }),
    );

    const result = yield* fs.readFileString(target);
    expect(result).toContain("export FOO=bar");
    expect(result).toContain("# machine-run:example BEGIN");
    expect(result).toContain('export MACHINE_RUN="1"');
    expect(result).toContain("# machine-run:example END");
  }),
);

test.provider("re-applying updates only the marked block", (stack) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, ".zshrc");
    yield* fs.writeFileString(target, "# hand-written setup\n");

    yield* stack.deploy(
      Dotfiles.ManagedBlock("example-block", {
        path: target,
        marker: "example",
        content: "export A=1",
      }),
    );
    yield* stack.deploy(
      Dotfiles.ManagedBlock("example-block", {
        path: target,
        marker: "example",
        content: "export A=2",
      }),
    );

    const result = yield* fs.readFileString(target);
    expect(result).toContain("# hand-written setup");
    expect(result).toContain("export A=2");
    expect(result).not.toContain("export A=1");
    expect(result.match(/BEGIN/g)?.length).toBe(1);
  }),
);
