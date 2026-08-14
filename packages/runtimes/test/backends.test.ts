import { NodeServices } from "@effect/platform-node";
import type { Exec } from "@machine-run/engine";
import { expect, it } from "@effect/vitest";
import * as nodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { RuntimeScope } from "../src/Backend.ts";
import { makeAsdfBackend } from "../src/backends/Asdf.ts";
import { makeMiseBackend } from "../src/backends/Mise.ts";
import { makeRustupBackend } from "../src/backends/Rustup.ts";
import { makeUvBackend } from "../src/backends/Uv.ts";

/** Renders a fixture as JSON text — `Schema.Json` rather than `JSON.stringify`. */
const toJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

/**
 * A command runner returning fixed output — the same fixture pattern as
 * `system-packages/test/backends.test.ts`. Every fixture below is real,
 * captured output; see `docs/runtime-notes.md` for how and where.
 */
const fakeExec =
  (stdout: string): Exec =>
  () =>
    Effect.succeed({ exitCode: 0, stdout, stderr: "" });

/** The same, but recording every call's command and cwd. */
const capturingExec = (
  stdout: string,
  calls: Array<{ command: string; cwd: string | undefined }>,
): Exec =>
  (props) => {
    calls.push({ command: props.command, cwd: props.cwd });
    return Effect.succeed({ exitCode: 0, stdout, stderr: "" });
  };

/** Queues a distinct fixture per call, for backends that shell out more than once per `observe`. */
const sequencedExec = (outputs: readonly string[]): Exec => {
  let i = 0;
  return () => {
    const stdout = outputs[i] ?? "";
    i += 1;
    return Effect.succeed({ exitCode: 0, stdout, stderr: "" });
  };
};

const HOME = "/home/test";

/**
 * Joins with the platform's own separator, so an expected path matches what
 * `Path.join` actually produced. A literal "/a/b" assertion passes on POSIX
 * and fails on Windows for a path the code built correctly.
 */
const p = (...segments: readonly string[]): string => nodePath.join(...segments);

const GLOBAL: RuntimeScope = { _tag: "Global" };
const dir = (path: string): RuntimeScope => ({ _tag: "Directory", path });

// ---------------------------------------------------------------------------
// mise
// ---------------------------------------------------------------------------

it.effect("mise backend: observe reads installed+active from `mise ls <tool> --json`", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const backend = makeMiseBackend({ home: HOME, path, globalConfigOverride: undefined });
    // Real captured output (`mise 2026.7.18`): one version installed and
    // active, from `mise ls node --json` inside a project with its own
    // `mise.toml`.
    const observation = yield* backend.observe(
      { tool: "node", version: "20" },
      GLOBAL,
      fakeExec(
        toJsonText([
          {
            version: "20.20.2",
            requested_version: "20.20.2",
            install_path: "/home/test/.local/share/mise/installs/node/20.20.2",
            source: { type: "mise.toml", path: "/home/test/proj/mise.toml" },
            installed: true,
            active: true,
          },
        ]),
      ),
    );
    expect(observation).toEqual({ installed: ["20.20.2"], active: "20.20.2" });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "mise backend: observe reports installed but not-yet-active alongside a requested-not-installed entry",
  () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const backend = makeMiseBackend({ home: HOME, path, globalConfigOverride: undefined });
      // Real captured output: 22.23.2 installed via a local override, not
      // active because a global `mise.toml` requesting node 26 takes
      // precedence in this listing's resolution.
      const observation = yield* backend.observe(
        { tool: "node", version: "22" },
        GLOBAL,
        fakeExec(
          toJsonText([
            { version: "22.23.2", install_path: "/x/22.23.2", installed: true, active: false },
            {
              version: "26.7.0",
              requested_version: "26",
              install_path: "/x/26.7.0",
              source: { type: "mise.toml", path: "/home/test/.config/mise/config.toml" },
              installed: false,
              active: false,
            },
          ]),
        ),
      );
      expect(observation).toEqual({ installed: ["22.23.2"], active: undefined });
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("mise backend: observe reports nothing for a tool that has never been installed", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const backend = makeMiseBackend({ home: HOME, path, globalConfigOverride: undefined });
    // Real captured output: `mise ls python --json` against a fresh mise
    // home with nothing installed prints a bare empty array, exit 0.
    const observation = yield* backend.observe(
      { tool: "python", version: "3.12" },
      GLOBAL,
      fakeExec("[]"),
    );
    expect(observation).toEqual({ installed: [], active: undefined });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("mise backend: observe passes cwd=home for Global and cwd=dir for Directory", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const backend = makeMiseBackend({ home: HOME, path, globalConfigOverride: undefined });
    const calls: Array<{ command: string; cwd: string | undefined }> = [];
    const identity = { tool: "node", version: "22" };
    yield* backend.observe(identity, GLOBAL, capturingExec("[]", calls));
    yield* backend.observe(identity, dir("/home/test/proj"), capturingExec("[]", calls));
    expect(calls).toEqual([
      { command: "mise ls node --json", cwd: HOME },
      { command: "mise ls node --json", cwd: "/home/test/proj" },
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("mise backend: install shells to `mise install <tool>@<version>`", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const backend = makeMiseBackend({ home: HOME, path, globalConfigOverride: undefined });
    const calls: Array<{ command: string; cwd: string | undefined }> = [];
    yield* backend.install({ tool: "node", version: "22" }, capturingExec("", calls));
    expect(calls).toEqual([{ command: "mise install node@22", cwd: undefined }]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("mise backend: activate at Global scope uses `--global`, no cwd", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const backend = makeMiseBackend({ home: HOME, path, globalConfigOverride: undefined });
    const calls: Array<{ command: string; cwd: string | undefined }> = [];
    yield* backend.activate({ tool: "node", version: "22" }, GLOBAL, capturingExec("", calls));
    expect(calls).toEqual([{ command: "mise use --global --pin -y node@22", cwd: undefined }]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("mise backend: activate at Directory scope sets cwd, no `--global`", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const backend = makeMiseBackend({ home: HOME, path, globalConfigOverride: undefined });
    const calls: Array<{ command: string; cwd: string | undefined }> = [];
    yield* backend.activate(
      { tool: "node", version: "22" },
      dir("/home/test/proj"),
      capturingExec("", calls),
    );
    expect(calls).toEqual([{ command: "mise use --pin -y node@22", cwd: "/home/test/proj" }]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "mise backend: configPath is the global config for Global and <dir>/mise.toml for Directory",
  () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const backend = makeMiseBackend({ home: HOME, path, globalConfigOverride: undefined });
      expect(backend.configPath(GLOBAL)).toBe(p(HOME, ".config", "mise", "config.toml"));
      expect(backend.configPath(dir("/home/test/proj"))).toBe(p(HOME, "proj", "mise.toml"));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("mise backend: configPath honours a resolved MISE_GLOBAL_CONFIG_FILE override", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    // `Tool.ts` resolves `MISE_GLOBAL_CONFIG_FILE` itself, once, via
    // `effect/Config`, and hands the already-resolved value to this factory
    // — this backend never reads `process.env` directly (see `Mise.ts`'s
    // doc comment for `globalConfigOverride`).
    const backend = makeMiseBackend({
      home: HOME,
      path,
      globalConfigOverride: "/elsewhere/config.toml",
    });
    expect(backend.configPath(GLOBAL)).toBe("/elsewhere/config.toml");
  }).pipe(Effect.provide(NodeServices.layer)),
);

// ---------------------------------------------------------------------------
// rustup
// ---------------------------------------------------------------------------

const RUSTUP_SHOW_DEFAULT_ACTIVE = `Default host: aarch64-apple-darwin
rustup home:  /Users/a/.rustup

installed toolchains
--------------------
stable-aarch64-apple-darwin
nightly-aarch64-apple-darwin
1.97.1-aarch64-apple-darwin (active, default)

active toolchain
----------------
name: 1.97.1-aarch64-apple-darwin
active because: it's the default toolchain
installed targets:
  aarch64-apple-darwin
`;

const RUSTUP_SHOW_DIRECTORY_OVERRIDE = `Default host: aarch64-apple-darwin
rustup home:  /Users/a/.rustup

installed toolchains
--------------------
stable-aarch64-apple-darwin
nightly-aarch64-apple-darwin (active)
1.97.1-aarch64-apple-darwin (default)

active toolchain
----------------
name: nightly-aarch64-apple-darwin
active because: directory override for '/private/tmp/proj'
installed targets:
  aarch64-apple-darwin
`;

it.effect(
  "rustup backend: observe strips the host triple and finds the default-active toolchain",
  () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const backend = makeRustupBackend({ home: HOME, path, rustupHomeOverride: undefined });
      const observation = yield* backend.observe(
        { channel: "stable" },
        GLOBAL,
        fakeExec(RUSTUP_SHOW_DEFAULT_ACTIVE),
      );
      expect(observation).toEqual({
        installed: ["stable", "nightly", "1.97.1"],
        active: "1.97.1",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "rustup backend: observe reports the directory-overridden toolchain as active, not the default",
  () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const backend = makeRustupBackend({ home: HOME, path, rustupHomeOverride: undefined });
      const observation = yield* backend.observe(
        { channel: "nightly" },
        dir("/private/tmp/proj"),
        fakeExec(RUSTUP_SHOW_DIRECTORY_OVERRIDE),
      );
      expect(observation).toEqual({
        installed: ["stable", "nightly", "1.97.1"],
        active: "nightly",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rustup backend: install/activate shell to the right subcommands", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const backend = makeRustupBackend({ home: HOME, path, rustupHomeOverride: undefined });
    const calls: Array<{ command: string; cwd: string | undefined }> = [];
    yield* backend.install({ channel: "1.75.0" }, capturingExec("", calls));
    yield* backend.activate({ channel: "1.75.0" }, GLOBAL, capturingExec("", calls));
    yield* backend.activate(
      { channel: "1.75.0" },
      dir("/private/tmp/proj"),
      capturingExec("", calls),
    );
    expect(calls).toEqual([
      { command: "rustup toolchain install 1.75.0", cwd: undefined },
      { command: "rustup default 1.75.0", cwd: undefined },
      { command: "rustup override set 1.75.0", cwd: "/private/tmp/proj" },
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('rustup backend: id is "Rustup", and configPath ignores scope', () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const backend = makeRustupBackend({ home: HOME, path, rustupHomeOverride: undefined });
    expect(backend.id).toBe("Rustup");
    // Rustup has no `tool` dimension at all — `RustupToolIdentity` (`Backend.ts`)
    // has no `tool` field, so there is nothing here for a caller to misname;
    // this replaces the old runtime-checked `fixedTool` field.
    //
    // Every scope shares one file — see `Rustup.ts`'s doc comment: the
    // directory-override table lives inside the same `settings.toml` as the
    // global default, verified directly by inspecting it after setting one.
    expect(backend.configPath(GLOBAL)).toBe(backend.configPath(dir("/private/tmp/proj")));
    expect(backend.configPath(GLOBAL)).toBe(p(HOME, ".rustup", "settings.toml"));
  }).pipe(Effect.provide(NodeServices.layer)),
);

// ---------------------------------------------------------------------------
// asdf
// ---------------------------------------------------------------------------

it.effect(
  "asdf backend: observe is empty, and issues one command, when the plugin was never added",
  () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const backend = makeAsdfBackend({ home: HOME, path, filenameOverride: undefined });
      const calls: Array<{ command: string; cwd: string | undefined }> = [];
      // Real captured output (`asdf 0.20.0`): a fresh asdf reports this,
      // exit 0, when nothing has ever been added.
      const observation = yield* backend.observe(
        { tool: "nodejs", version: "22" },
        GLOBAL,
        capturingExec("No plugins installed", calls),
      );
      expect(observation).toEqual({ installed: [], active: undefined });
      // `asdf list`/`asdf current` are never reached — both fail outright
      // against a plugin that was never added, and `observe` must stay
      // read-only (it cannot call `asdf plugin add` to fix that itself).
      expect(calls).toHaveLength(1);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("asdf backend: observe is empty when the plugin exists but nothing is installed", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const backend = makeAsdfBackend({ home: HOME, path, filenameOverride: undefined });
    // Real captured output: `asdf list nodejs` once the plugin is added but
    // before anything is installed.
    const observation = yield* backend.observe(
      { tool: "nodejs", version: "22" },
      GLOBAL,
      sequencedExec(["nodejs", "No compatible versions installed (nodejs)"]),
    );
    expect(observation).toEqual({ installed: [], active: undefined });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("asdf backend: observe finds the `*`-marked active version among several installed", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const backend = makeAsdfBackend({ home: HOME, path, filenameOverride: undefined });
    // Real captured output: two versions installed, the second active.
    const observation = yield* backend.observe(
      { tool: "nodejs", version: "22" },
      GLOBAL,
      sequencedExec(["nodejs", "  20.11.0\n *22.11.0"]),
    );
    expect(observation).toEqual({ installed: ["20.11.0", "22.11.0"], active: "22.11.0" });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("asdf backend: install adds the plugin (idempotently) before installing", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const backend = makeAsdfBackend({ home: HOME, path, filenameOverride: undefined });
    const calls: Array<{ command: string; cwd: string | undefined }> = [];
    yield* backend.install({ tool: "nodejs", version: "22.11.0" }, capturingExec("", calls));
    expect(calls).toEqual([
      { command: "asdf plugin add nodejs", cwd: undefined },
      { command: "asdf install nodejs 22.11.0", cwd: undefined },
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("asdf backend: activate uses `set -u` for Global and `set` with cwd for Directory", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const backend = makeAsdfBackend({ home: HOME, path, filenameOverride: undefined });
    const calls: Array<{ command: string; cwd: string | undefined }> = [];
    const identity = { tool: "nodejs", version: "22.11.0" };
    yield* backend.activate(identity, GLOBAL, capturingExec("", calls));
    yield* backend.activate(identity, dir("/home/test/proj"), capturingExec("", calls));
    expect(calls).toEqual([
      { command: "asdf set -u nodejs 22.11.0", cwd: undefined },
      { command: "asdf set nodejs 22.11.0", cwd: "/home/test/proj" },
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "asdf backend: configPath is <home>/.tool-versions for Global, <dir>/.tool-versions for Directory",
  () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const backend = makeAsdfBackend({ home: HOME, path, filenameOverride: undefined });
      expect(backend.configPath(GLOBAL)).toBe(p(HOME, ".tool-versions"));
      expect(backend.configPath(dir("/home/test/proj"))).toBe(p(HOME, "proj", ".tool-versions"));
    }).pipe(Effect.provide(NodeServices.layer)),
);

// ---------------------------------------------------------------------------
// uv
// ---------------------------------------------------------------------------

/** Real captured output: `uv python list --only-installed --output-format json` on this machine. */
const UV_PYTHON_LIST_ONLY_INSTALLED = toJsonText([
  {
    key: "cpython-3.14.6-macos-aarch64-none",
    version: "3.14.6",
    path: "/opt/homebrew/bin/python3.14",
    symlink: "../Cellar/python@3.14/3.14.6/bin/python3.14",
  },
  {
    key: "cpython-3.14.6-macos-aarch64-none",
    version: "3.14.6",
    path: "/opt/homebrew/bin/python3",
    symlink: "../Cellar/python@3.14/3.14.6/bin/python3",
  },
  {
    key: "cpython-3.11.15-macos-aarch64-none",
    version: "3.11.15",
    path: "/Users/a/.local/bin/python3.11",
    symlink: "/Users/a/.local/share/uv/python/cpython-3.11-macos-aarch64-none/bin/python3.11",
  },
  {
    key: "cpython-3.11.15-macos-aarch64-none",
    version: "3.11.15",
    path: "/Users/a/.local/share/uv/python/cpython-3.11-macos-aarch64-none/bin/python3.11",
    symlink: null,
  },
  {
    key: "cpython-3.9.6-macos-aarch64-none",
    version: "3.9.6",
    path: "/usr/bin/python3",
    symlink: null,
  },
]);

it.effect("uv backend: observe de-duplicates versions reported through more than one path", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const backend = makeUvBackend({ home: HOME, path, fs, configDirOverride: undefined });
    const observation = yield* backend.observe(
      { version: "3.11" },
      GLOBAL,
      fakeExec(UV_PYTHON_LIST_ONLY_INSTALLED),
    );
    expect([...observation.installed].sort()).toEqual(["3.11.15", "3.14.6", "3.9.6"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("uv backend: observe reads the active version from the pin file it writes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathSvc = yield* Path.Path;
    const backend = makeUvBackend({ home: HOME, path: pathSvc, fs, configDirOverride: undefined });
    const projectDir = yield* fs.makeTempDirectoryScoped();

    // Real captured content: `uv python pin 3.11` writes the literal
    // request, not a resolved patch version.
    yield* fs.writeFileString(pathSvc.join(projectDir, ".python-version"), "3.11\n");

    const observation = yield* backend.observe(
      { version: "3.11" },
      dir(projectDir),
      fakeExec("[]"),
    );
    expect(observation.active).toBe("3.11");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("uv backend: observe reports no active version when the pin file does not exist", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathSvc = yield* Path.Path;
    const backend = makeUvBackend({ home: HOME, path: pathSvc, fs, configDirOverride: undefined });
    const projectDir = yield* fs.makeTempDirectoryScoped();

    const observation = yield* backend.observe(
      { version: "3.11" },
      dir(projectDir),
      fakeExec("[]"),
    );
    expect(observation.active).toBeUndefined();
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("uv backend: install/activate shell to `uv python install`/`pin`", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathSvc = yield* Path.Path;
    const backend = makeUvBackend({ home: HOME, path: pathSvc, fs, configDirOverride: undefined });
    const calls: Array<{ command: string; cwd: string | undefined }> = [];
    yield* backend.install({ version: "3.12" }, capturingExec("", calls));
    yield* backend.activate({ version: "3.12" }, GLOBAL, capturingExec("", calls));
    yield* backend.activate({ version: "3.12" }, dir("/home/test/proj"), capturingExec("", calls));
    expect(calls).toEqual([
      { command: "uv python install 3.12", cwd: undefined },
      { command: "uv python pin --global 3.12", cwd: undefined },
      { command: "uv python pin 3.12", cwd: "/home/test/proj" },
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('uv backend: id is "Uv", configPath is <dir>/.python-version for Directory', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathSvc = yield* Path.Path;
    const backend = makeUvBackend({
      home: HOME,
      path: pathSvc,
      fs,
      configDirOverride: undefined,
    });
    expect(backend.id).toBe("Uv");
    // uv has no `tool` dimension either — `UvToolIdentity` (`Backend.ts`) has
    // no `tool` field, replacing the old runtime-checked `fixedTool` field.
    expect(backend.configPath(dir("/home/test/proj"))).toBe(p(HOME, "proj", ".python-version"));
  }).pipe(Effect.provide(NodeServices.layer)),
);
