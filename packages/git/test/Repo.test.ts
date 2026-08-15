import { MachinePaths, PlatformFor, Sh } from "@machine-run/core";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { platform as nodePlatform } from "node:os";
import { CommandError, UnexpectedExit } from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import {
  GitRepoCommandFailed,
  GitRepoPathOccupied,
  GitRepoPathUnreadable,
  makeGitRepoReconciler,
} from "../src/Repo.ts";

const testPaths = Layer.succeed(MachinePaths, {
  home: "/home/test",
  expand: (target: string) => target,
});

const layer = Layer.mergeAll(testPaths, PlatformFor("linux")).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const expectedGit = (...argv: readonly string[]): string => Sh.sh("git", ...argv);

// Windows chmod cannot make a parent directory unsearchable; the real
// permission-error invariant is exercised by the POSIX test and the Windows
// ACL seam is covered independently.
const POSIX_PERMISSIONS_AVAILABLE = nodePlatform() !== "win32";

/** Fails the way real `git -C <path> rev-parse --show-toplevel` does when `path` is not inside any repository. */
const notARepo = () =>
  Effect.fail(
    new CommandError({
      command: "git rev-parse --show-toplevel",
      reason: new UnexpectedExit({
        exitCode: 128,
        stderr: "fatal: not a git repository (or any of the parent directories): .git",
      }),
    }),
  );

/** A fake `Exec` for a repo whose toplevel is `root` and whose `origin` points at `remote` (or is unset). */
const repoAt = (root: string, remote: string | undefined) => ({
  exec: (props: { command: string }) => {
    if (props.command.includes("show-toplevel")) {
      return Effect.succeed({ exitCode: 0, stdout: `${root}\n`, stderr: "" });
    }
    if (
      props.command.includes("remote") &&
      props.command.includes("get-url") &&
      props.command.includes("origin")
    ) {
      return remote === undefined
        ? Effect.fail(
            new CommandError({
              command: props.command,
              reason: new UnexpectedExit({ exitCode: 2, stderr: "error: No such remote 'origin'" }),
            }),
          )
        : Effect.succeed({ exitCode: 0, stdout: `${remote}\n`, stderr: "" });
    }
    return Effect.die(`unexpected command in test: ${props.command}`);
  },
});

const notARepoExec = { exec: () => notARepo() };

const applyCtx = (exec: ReturnType<typeof repoAt>["exec"]) => ({
  exec,
  snapshot: () => Effect.succeed(undefined),
});

it.effect("observe reports absent when nothing exists at the path yet", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeGitRepoReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "does-not-exist");

    const observed = yield* reconciler.observe(
      { path: target, remote: "irrelevant" },
      notARepoExec,
    );
    expect(Option.isNone(observed)).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "observe reports absent for an existing but empty directory — `git clone` accepts one",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeGitRepoReconciler;
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = path.join(dir, "empty");
      yield* fs.makeDirectory(target);

      const observed = yield* reconciler.observe(
        { path: target, remote: "irrelevant" },
        notARepoExec,
      );
      expect(Option.isNone(observed)).toBe(true);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "observe fails with GitRepoPathOccupied for a non-empty directory that is not a repository",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeGitRepoReconciler;
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = path.join(dir, "occupied");
      yield* fs.makeDirectory(target);
      yield* fs.writeFileString(path.join(target, "README.md"), "hand-written");

      const error = yield* reconciler
        .observe({ path: target, remote: "irrelevant" }, notARepoExec)
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(GitRepoPathOccupied);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "observe fails with GitRepoPathOccupied for a directory nested inside a different repository",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeGitRepoReconciler;
      const dir = yield* fs.makeTempDirectoryScoped();
      const ancestorRoot = dir;
      const nested = path.join(dir, "nested");
      yield* fs.makeDirectory(nested);
      yield* fs.writeFileString(path.join(nested, "file"), "content");

      // `--show-toplevel` succeeds, but reports the *ancestor's* root, not
      // `nested` itself — verified live that an empty subdirectory of an
      // unrelated repository answers `--is-inside-work-tree` with `true`
      // without ever having been `git init`'d itself.
      const error = yield* reconciler
        .observe(
          { path: nested, remote: "irrelevant" },
          { exec: () => Effect.succeed({ exitCode: 0, stdout: `${ancestorRoot}\n`, stderr: "" }) },
        )
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(GitRepoPathOccupied);
    }).pipe(Effect.provide(layer)),
);

it.effect("observe reports the configured remote when the path is its own repository root", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeGitRepoReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "repo");
    yield* fs.makeDirectory(target);

    const observed = yield* reconciler.observe(
      { path: target, remote: "irrelevant" },
      repoAt(target, "git@example.com:me/repo.git"),
    );
    expect(observed).toEqual(Option.some({ path: target, remote: "git@example.com:me/repo.git" }));
  }).pipe(Effect.provide(layer)),
);

it.effect("observe reports no `remote` field when the repository has no `origin` at all", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeGitRepoReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "repo");
    yield* fs.makeDirectory(target);

    const observed = yield* reconciler.observe(
      { path: target, remote: "irrelevant" },
      repoAt(target, undefined),
    );
    expect(observed).toEqual(Option.some({ path: target }));
  }).pipe(Effect.provide(layer)),
);

it.effect.skipIf(!POSIX_PERMISSIONS_AVAILABLE)(
  "observe fails with GitRepoPathUnreadable rather than reporting absent when the path cannot be stat'd",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeGitRepoReconciler;
      const dir = yield* fs.makeTempDirectoryScoped();
      const locked = path.join(dir, "locked");
      const target = path.join(locked, "repo");
      yield* fs.makeDirectory(locked);
      // A real permission-denied `stat` — not a fabricated `PlatformError` —
      // the same discipline `MUST_CLEANUP.md` demands for every backend:
      // stripping every permission bit off the parent makes even looking up
      // `target`'s name fail with `EACCES`, distinct from `target` simply
      // not existing.
      yield* fs.chmod(locked, 0o000);

      const error = yield* reconciler
        .observe({ path: target, remote: "irrelevant" }, notARepoExec)
        .pipe(Effect.ensuring(Effect.orDie(fs.chmod(locked, 0o700))), Effect.flip);
      expect(error).toBeInstanceOf(GitRepoPathUnreadable);
    }).pipe(Effect.provide(layer)),
);

it.effect("observe surfaces a real command failure rather than treating it as absent", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeGitRepoReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "repo");
    yield* fs.makeDirectory(target);

    const error = yield* reconciler
      .observe(
        { path: target, remote: "irrelevant" },
        {
          exec: () =>
            Effect.fail(
              new CommandError({
                command: "git rev-parse --show-toplevel",
                reason: new UnexpectedExit({ exitCode: 128, stderr: "fatal: unknown corruption" }),
              }),
            ),
        },
      )
      .pipe(Effect.flip);
    expect(error).toBeInstanceOf(GitRepoCommandFailed);
  }).pipe(Effect.provide(layer)),
);

// --- drift: agrees with matches; `remote` gets no direction, it's a URL. ---

it.effect("drift is empty exactly when matches is true", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeGitRepoReconciler;
    const state = { path: "/repo", remote: "git@example.com:me/repo.git" };

    expect(reconciler.matches(state, state)).toBe(true);
    expect(reconciler.drift?.(state, state)).toEqual([]);
  }).pipe(Effect.provide(layer)),
);

it.effect("drift reports a 'remote' field, with no direction, for a differing remote", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeGitRepoReconciler;
    const observed = { path: "/repo", remote: "https://example.com/old.git" };
    const desired = { path: "/repo", remote: "https://example.com/new.git" };

    expect(reconciler.matches(observed, desired)).toBe(false);
    expect(reconciler.drift?.(observed, desired)).toEqual([
      {
        field: "remote",
        observed: "https://example.com/old.git",
        desired: "https://example.com/new.git",
      },
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("drift reports '(none)' for a missing remote rather than leaving the field out", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeGitRepoReconciler;
    const observed = { path: "/repo" };
    const desired = { path: "/repo", remote: "https://example.com/repo.git" };

    expect(reconciler.matches(observed, desired)).toBe(false);
    expect(reconciler.drift?.(observed, desired)).toEqual([
      { field: "remote", observed: "(none)", desired: "https://example.com/repo.git" },
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "apply clones when nothing was observed, never pre-creating the target directory itself",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* makeGitRepoReconciler;
      const dir = yield* fs.makeTempDirectoryScoped();
      const target = path.join(dir, "fresh-clone");

      const calls: string[] = [];
      const props = { path: target, remote: "https://example.com/repo.git", branch: "main" };
      const desired = yield* reconciler.desired(props);
      const result = yield* reconciler.apply(
        { props, observed: Option.none(), desired },
        applyCtx((commandProps) => {
          calls.push(commandProps.command);
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        }),
      );

      expect(result).toEqual(desired);
      expect(calls).toEqual([
        expectedGit(
          "clone",
          "--branch",
          "main",
          "--origin",
          "origin",
          "https://example.com/repo.git",
          target,
        ),
      ]);
    }).pipe(Effect.provide(layer)),
);

it.effect("apply adds `origin` when the repository exists but has none configured", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const reconciler = yield* makeGitRepoReconciler;
    const target = path.join("/tmp", "existing-repo");

    const calls: string[] = [];
    const props = { path: target, remote: "https://example.com/repo.git" };
    const desired = yield* reconciler.desired(props);
    const result = yield* reconciler.apply(
      { props, observed: Option.some({ path: target }), desired },
      applyCtx((commandProps) => {
        calls.push(commandProps.command);
        return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
      }),
    );

    expect(result).toEqual(desired);
    expect(calls).toEqual([
      expectedGit("-C", target, "remote", "add", "origin", "https://example.com/repo.git"),
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "apply fixes the remote with set-url — never checkout/reset/clean/pull — when it differs",
  () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const reconciler = yield* makeGitRepoReconciler;
      const target = path.join("/tmp", "existing-repo");

      const calls: string[] = [];
      const props = { path: target, remote: "https://example.com/new.git" };
      const desired = yield* reconciler.desired(props);
      yield* reconciler.apply(
        {
          props,
          observed: Option.some({ path: target, remote: "https://example.com/old.git" }),
          desired,
        },
        applyCtx((commandProps) => {
          calls.push(commandProps.command);
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        }),
      );

      expect(calls).toEqual([
        expectedGit("-C", target, "remote", "set-url", "origin", "https://example.com/new.git"),
      ]);
    }).pipe(Effect.provide(layer)),
);

it.effect("apply does nothing when the remote already matches", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const reconciler = yield* makeGitRepoReconciler;
    const target = path.join("/tmp", "existing-repo");

    const calls: string[] = [];
    const props = { path: target, remote: "https://example.com/repo.git" };
    const desired = yield* reconciler.desired(props);
    yield* reconciler.apply(
      {
        props,
        observed: Option.some({ path: target, remote: "https://example.com/repo.git" }),
        desired,
      },
      applyCtx((commandProps) => {
        calls.push(commandProps.command);
        return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
      }),
    );

    expect(calls).toEqual([]);
  }).pipe(Effect.provide(layer)),
);
