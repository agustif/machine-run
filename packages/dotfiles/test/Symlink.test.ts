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

test.provider("fails clearly when the source doesn't exist", (stack) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const link = path.join(dir, "linked");
    const source = path.join(dir, "does-not-exist");

    const result = yield* stack
      .deploy(Dotfiles.Symlink("example", { path: link, source }))
      .pipe(Effect.flip);

    expect(result._tag).toBe("SymlinkSourceMissing");
  }),
);

test.provider("links path to source and backs up pre-existing real content", (stack) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const source = path.join(dir, "source.txt");
    const link = path.join(dir, "linked.txt");
    yield* fs.writeFileString(source, "source content\n");
    yield* fs.writeFileString(link, "pre-existing real content\n");

    const attrs = yield* stack.deploy(Dotfiles.Symlink("example", { path: link, source }));

    expect(attrs.source).toBe(source);
    expect(yield* fs.readFileString(link)).toBe("source content\n");

    const backupsDir = path.join(dir, ".machine-run-backups");
    expect(yield* fs.exists(backupsDir)).toBe(true);
  }),
);
