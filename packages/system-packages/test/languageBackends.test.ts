import type { Exec, ExecutionContext } from "@machine-run/engine";
import { expect, it } from "@effect/vitest";
import * as Fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import { makeCargoBackend } from "../src/backends/language/Cargo.ts";
import { makeGemBackend } from "../src/backends/language/Gem.ts";
import { makeGoBackend, parseGoVersionM } from "../src/backends/language/Go.ts";
import { makeNpmBackend } from "../src/backends/language/Npm.ts";
import { makePipxBackend, parsePipxList } from "../src/backends/language/Pipx.ts";
import { makeUvToolBackend, parseUvToolList } from "../src/backends/language/UvTool.ts";

/**
 * The six language-manager parsers, pinned against output captured from real
 * containers rather than this machine's own installs (the earlier basis for
 * these backends — see each module's own doc comment and
 * `docs/notes/system-packages-notes.md` for that history).
 *
 * Every fixture here came from a session that ran the real tool inside
 * Docker and copied its stdout verbatim, exercising each backend's `install`
 * once (an empty listing does not prove the populated-listing parse path)
 * and then its `list`/exported parser a second time:
 *
 * - `rust:latest` — `cargo install --list` before and after
 *   `cargo install just --locked` + `cargo install ripgrep --locked`.
 * - `node:22` — `npm ls -g --depth=0 --json` before and after
 *   `npm install -g cowsay` + `npm install -g typescript`.
 * - `python:3.12` — `pipx list --short` before and after
 *   `pipx install cowsay` + `pipx install yt-dlp` (pipx 1.16.6), and
 *   `uv tool list` before and after the same two packages via
 *   `uv tool install` (uv 0.12.4).
 * - `ruby:3.3` — `gem list --local` (Ruby 3.3.12, gem 3.5.22) after
 *   `gem install --user-install cowsay` and two more pinned `rake` versions
 *   (the image already carried one), confirming the multi-version and
 *   default-gem line shapes on a second, non-macOS Ruby.
 * - `golang:1.23` — `go version -m "$GOPATH/bin"/*` before and after
 *   `go install golang.org/x/tools/cmd/goimports@v0.21.0` +
 *   `.../stringer@v0.21.0` (pinned below `@latest`'s own floor of Go 1.25,
 *   which this container's Go 1.23.12 does not meet — a real, if incidental,
 *   finding: `go install <path>@latest` can fail outright on an older Go
 *   toolchain with a module-graph error, not a missing-binary one).
 *
 * All six parsers matched their container output exactly on the first try;
 * nothing here required a code change for names. Every entry's `version` is
 * likewise read straight from the same real fixtures, added once
 * `PackageEntry` gave each parser somewhere to put it.
 */
const fixture = (name: string): string =>
  Fs.readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

const fakeExec =
  (stdout: string): Exec =>
  () =>
    Effect.succeed({ exitCode: 0, stdout, stderr: "" });

/** None of these backends ever elevate — `execution` is only ever passed through. */
const NONE: ExecutionContext = { privilege: "none", locale: "C", defaultTimeout: "10 minutes" };

it.effect("cargo backend parses real `cargo install --list` output (rust:latest)", () =>
  Effect.gen(function* () {
    const installed = yield* makeCargoBackend().list(fakeExec(fixture("cargo-install-list.txt")));
    expect(installed).toEqual([
      { name: "just", version: "1.58.0" },
      { name: "ripgrep", version: "15.2.0" },
    ]);
  }),
);

it.effect(
  "cargo backend install pins with `--version <v>`, verified against a real downgrade (rust:latest)",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const exec: Exec = (props) => {
        calls.push(props.command);
        return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
      };
      yield* makeCargoBackend().install("just", { _tag: "Exact", version: "1.5.0" }, exec, NONE);
      expect(calls).toEqual(["cargo install just --version 1.5.0"]);
    }),
);

it.effect("npm backend parses real `npm ls -g --depth=0 --json` output (node:22)", () =>
  Effect.gen(function* () {
    const before = yield* makeNpmBackend().list(fakeExec(fixture("npm-ls-global-before.json")));
    expect(before.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "corepack", version: "0.34.6" },
      { name: "npm", version: "10.9.8" },
    ]);

    const after = yield* makeNpmBackend().list(fakeExec(fixture("npm-ls-global-after.json")));
    expect(after.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "corepack", version: "0.34.6" },
      { name: "cowsay", version: "1.6.0" },
      { name: "npm", version: "10.9.8" },
      { name: "typescript", version: "7.0.2" },
    ]);
  }),
);

it("parsePipxList matches real `pipx list --short` output (python:3.12, pipx 1.16.6)", () => {
  expect(parsePipxList(fixture("pipx-list-empty.txt"))).toEqual([]);
  expect(parsePipxList(fixture("pipx-list.txt"))).toEqual([
    { name: "cowsay", version: "6.1" },
    { name: "yt-dlp", version: "2026.7.4" },
  ]);
});

it("parseUvToolList matches real `uv tool list` output (python:3.12, uv 0.12.4)", () => {
  expect(parseUvToolList(fixture("uv-tool-list-empty.txt"))).toEqual([]);
  expect(parseUvToolList(fixture("uv-tool-list.txt"))).toEqual([
    { name: "cowsay", version: "6.1" },
    { name: "yt-dlp", version: "2026.7.4" },
  ]);
});

it.effect(
  "gem backend parses real `gem list --local` output (ruby:3.3, Ruby 3.3.12 / gem 3.5.22)",
  () =>
    Effect.gen(function* () {
      const installed = yield* makeGemBackend().list(fakeExec(fixture("gem-list-local.txt")));
      // A full stdlib-plus-installed-gems listing (72 lines) captured after
      // both installs: every default gem, `cowsay` (single version) and
      // `rake` (three versions, collapsed into one parenthetical by `gem
      // list` itself, newest-first) must each appear exactly once.
      const names = installed.map((e) => e.name);
      expect(names).toContain("cowsay");
      expect(names).toContain("rake");
      expect(names).toContain("bigdecimal");
      expect(names.filter((name) => name === "rake")).toHaveLength(1);
      expect(installed).toHaveLength(72);
      // `rake`'s reported version is the first (newest) of the three
      // parenthesised versions — see `Gem.ts`'s doc comment on why only the
      // first is reported.
      expect(installed.find((e) => e.name === "rake")?.version).toBe("13.4.2");
    }),
);

it("parseGoVersionM matches real `go version -m $GOPATH/bin/*` output (golang:1.23)", () => {
  expect(parseGoVersionM(fixture("go-version-m.txt"))).toEqual([
    { name: "golang.org/x/tools/cmd/goimports", version: "v0.21.0" },
    { name: "golang.org/x/tools/cmd/stringer", version: "v0.21.0" },
  ]);
  // Before either `go install`, the bin directory doesn't exist, the glob
  // doesn't expand, and `go version -m` fails on the literal `*` — the
  // backend's own command discards that with `2>/dev/null; true`, so `list`
  // only ever observes empty stdout, confirmed by actually running the exact
  // command against an empty bin directory in the container.
  expect(parseGoVersionM("")).toEqual([]);
});

it.effect("go-install backend install shells out to `go install <name>@latest`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const exec: Exec = (props) => {
      calls.push(props.command);
      return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
    };
    yield* makeGoBackend().install("golang.org/x/tools/cmd/goimports", undefined, exec, NONE);
    expect(calls).toEqual(["go install golang.org/x/tools/cmd/goimports@latest"]);
  }),
);

it.effect(
  "go-install backend install pins an exact version with `path@version`, verified against a real downgrade",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const exec: Exec = (props) => {
        calls.push(props.command);
        return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
      };
      yield* makeGoBackend().install(
        "golang.org/x/tools/cmd/goimports",
        { _tag: "Exact", version: "v0.19.0" },
        exec,
        NONE,
      );
      expect(calls).toEqual(["go install golang.org/x/tools/cmd/goimports@v0.19.0"]);
    }),
);

it.effect("uv-tool backend install shells out to `uv tool install <name>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const exec: Exec = (props) => {
      calls.push(props.command);
      return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
    };
    yield* makeUvToolBackend().install("cowsay", undefined, exec, NONE);
    expect(calls).toEqual(["uv tool install cowsay"]);
  }),
);

it.effect("pipx backend install shells out to `pipx install <name>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const exec: Exec = (props) => {
      calls.push(props.command);
      return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
    };
    yield* makePipxBackend().install("cowsay", undefined, exec, NONE);
    expect(calls).toEqual(["pipx install cowsay"]);
  }),
);
