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

test.provider("writes desired content to a new file", (stack) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "example.conf");

    const attrs = yield* stack.deploy(
      Dotfiles.File("example", { path: target, content: "a = 1\n" }),
    );

    expect(attrs.path).toBe(target);
    expect(yield* fs.readFileString(target)).toBe("a = 1\n");
  }),
);

test.provider("re-applying changed content overwrites the file", (stack) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "example.conf");

    yield* stack.deploy(Dotfiles.File("example", { path: target, content: "a = 1\n" }));
    yield* stack.deploy(Dotfiles.File("example", { path: target, content: "a = 2\n" }));

    expect(yield* fs.readFileString(target)).toBe("a = 2\n");
  }),
);
