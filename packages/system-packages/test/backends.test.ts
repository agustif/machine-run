import type { ApplyContext, Exec, ExecutionContext, ObserveContext } from "@machine-run/engine";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { makeYayBackend, makeParuBackend } from "../src/backends/linux/Aur.ts";
import { makeAptBackend, makeAptRepoBackend } from "../src/backends/linux/Apt.ts";
import { makeFlatpakBackend, makeFlatpakRepoBackend } from "../src/backends/linux/Flatpak.ts";
import { makeSnapBackend } from "../src/backends/linux/Snap.ts";
import {
  makeBrewBackend,
  makeBrewCaskBackend,
  makeBrewRepoBackend,
} from "../src/backends/macos/Brew.ts";
import { makeGoBackend, parseGoVersionM } from "../src/backends/language/Go.ts";
import { makeCargoBackend } from "../src/backends/language/Cargo.ts";
import { makeGemBackend } from "../src/backends/language/Gem.ts";
import { makeChocoBackend } from "../src/backends/windows/Choco.ts";
import { makeDnfBackend, makeDnfRepoBackend } from "../src/backends/linux/Dnf.ts";
import { makeMasBackend } from "../src/backends/macos/Mas.ts";
import { makePortBackend } from "../src/backends/macos/MacPorts.ts";
import { makeNpmBackend } from "../src/backends/language/Npm.ts";
import { makePacmanBackend } from "../src/backends/linux/Pacman.ts";
import { makePipxBackend, parsePipxList } from "../src/backends/language/Pipx.ts";
import { makeUvToolBackend, parseUvToolList } from "../src/backends/language/UvTool.ts";
import {
  makeWingetBackend,
  parseWingetExport,
  parseWingetList,
} from "../src/backends/windows/Winget.ts";
import type { PackageListContext } from "../src/Backend.ts";
import {
  makePackageReconciler as makePackageReconcilerEffect,
  type PackageProps,
  type PackageState,
} from "../src/Package.ts";
import { toId } from "../src/bulk.ts";
import { firstTokens, lines } from "../src/parse.ts";
import { makeRepoReconciler, type RepoProps } from "../src/Repo.ts";

/** Renders a fixture as JSON text — `Schema.Json` rather than `JSON.stringify`. */
const toJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

/**
 * A command runner returning fixed output, which is all a backend needs to be
 * exercised: parsing and command shape are the whole of its behaviour, and
 * neither requires a real shell or a `CommandExecutor`.
 */
const fakeExec =
  (stdout: string): Exec =>
  () =>
    Effect.succeed({ exitCode: 0, stdout, stderr: "" });

/** The same, but recording the command strings it was asked to run. */
const capturingExec =
  (stdout: string, calls: string[]): Exec =>
  (props) => {
    calls.push(props.command);
    return Effect.succeed({ exitCode: 0, stdout, stderr: "" });
  };

/** Real captured CLI output committed under `test/fixtures/` — see `languageBackends.test.ts`. */
const fixture = (name: string): string =>
  Fs.readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

const packageListContext = (
  content: string,
  path = "C:\\runner temp\\winget-export.json",
): PackageListContext => ({
  withTemporaryFile: (use) => use({ path, read: Effect.succeed(content) }),
});

/** An `ObserveContext` — the shape `diff`/`read` pass while planning. */
const planCtx = (exec: Exec): ObserveContext => ({ exec });

/**
 * An `ApplyContext` — the shape `reconcile` passes both to its pre-apply
 * re-observe and to `apply` itself. `snapshot` is never called by
 * `Package`/`Repo` (neither sets `snapshotBeforeApply`), so a stub that dies
 * if invoked keeps that invariant honest. `execution` defaults to unset, so
 * `executionOf` falls back to `DEFAULT_EXECUTION` — `privilege: "none"` —
 * the same as a caller that never mentions it at all.
 */
const applyCtx = (exec: Exec, execution?: ExecutionContext): ApplyContext => ({
  exec,
  execution,
  snapshot: () => Effect.die("Package/Repo never snapshot — snapshotBeforeApply is unset"),
});

/** No escalation — the common case (already root, or nothing to elevate with). */
const NONE: ExecutionContext = { privilege: "none", locale: "C", defaultTimeout: "10 minutes" };
/** `sudo`-prefixed commands. */
const SUDO: ExecutionContext = { privilege: "sudo", locale: "C", defaultTimeout: "10 minutes" };

// `makePackageReconciler` owns the temp-artifact capability used by Winget,
// so these direct reconciler tests provide the same platform services the real
// provider receives without changing the tests into engine/harness tests.
const makePackageReconciler = makePackageReconcilerEffect.pipe(Effect.provide(NodeServices.layer));

it.effect("brew backend parses `brew list --formula` output into names", () =>
  Effect.gen(function* () {
    const backend = makeBrewBackend();
    const installed = yield* backend.list(fakeExec("mise\nripgrep\nfd\n"));
    expect(installed).toEqual([{ name: "mise" }, { name: "ripgrep" }, { name: "fd" }]);
  }),
);

it.effect("brew backend install shells out to `brew install <name>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeBrewBackend();
    yield* backend.install("ripgrep", undefined, capturingExec("", calls), NONE);
    expect(calls).toEqual(["brew install ripgrep"]);
  }),
);

it.effect("brew backend refuses a version pin it cannot honour", () =>
  Effect.gen(function* () {
    const backend = makeBrewBackend();
    const result = yield* backend
      .install("ripgrep", { _tag: "Exact", version: "14.0.0" }, fakeExec(""), NONE)
      .pipe(Effect.flip);
    expect(result._tag).toBe("UnsupportedVersionSpec");
  }),
);

it.effect("brew backend list uses --full-name so a tap-qualified name matches", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeBrewBackend();
    // Real captured output: `brew list --formula --full-name` after tapping
    // koekeishiya/formulae and installing `koekeishiya/formulae/skhd` —
    // core-tap formulae (like "ada-url") stay bare, third-party-tap ones are
    // fully qualified. Plain `brew list --formula` (no --full-name) reported
    // the same install as the bare "skhd", which a recipe naming
    // "koekeishiya/formulae/skhd" would never match — the bug this fixes.
    const installed = yield* backend.list(
      capturingExec("ada-url\nkoekeishiya/formulae/skhd\n", calls),
    );
    expect(installed).toEqual([{ name: "ada-url" }, { name: "koekeishiya/formulae/skhd" }]);
    expect(calls).toEqual(["brew list --formula --full-name"]);
  }),
);

it.effect("brew-cask backend parses real `brew list --cask` output (this machine, read-only)", () =>
  Effect.gen(function* () {
    // Real captured output from this machine's own `brew list --cask` — a
    // plain list, one bare cask token per line, no header and no version
    // column the way `brew list --formula` (without `--full-name`) also has
    // none. Unlike formulae, cask tokens never carry a tap prefix here
    // because every one of these happens to come from `homebrew/cask`, but
    // the parser doesn't special-case that either way: it's the same
    // `lines()` used for plain `brew list --formula`.
    const backend = makeBrewCaskBackend();
    const installed = yield* backend.list(fakeExec(fixture("brew-list-cask.txt")));
    expect(installed).toEqual([
      { name: "android-commandlinetools" },
      { name: "ghostree" },
      { name: "ghostty" },
      { name: "jdownloader" },
      { name: "macterm" },
      { name: "markedit" },
      { name: "mori" },
      { name: "muxy" },
      { name: "orbstack" },
      { name: "slack" },
      { name: "stolendata-mpv" },
      { name: "transmission" },
      { name: "visual-studio-code" },
    ]);
  }),
);

it.effect(
  "brew-cask backend list reports versions from real `brew list --cask --versions` output (this machine)",
  () =>
    Effect.gen(function* () {
      // Real captured output from this real machine (see
      // test/fixtures/brew-list-cask-versions.txt) — `brew list --cask
      // --versions` prints `<name> <version>` pairs, including the literal
      // string "latest" for a cask that declares no real version
      // (`jdownloader latest`) and a comma-bearing version for one that
      // tracks two numbers at once (`orbstack 2.2.1,20628`) — neither is
      // treated specially, both are reported verbatim as `version`.
      const backend = makeBrewCaskBackend();
      const installed = yield* backend.list(fakeExec(fixture("brew-list-cask-versions.txt")));
      expect(installed).toEqual([
        { name: "android-commandlinetools", version: "15859902" },
        { name: "ghostree", version: "0.3.23" },
        { name: "ghostty", version: "1.3.1" },
        { name: "jdownloader", version: "latest" },
        { name: "macterm", version: "1.20.10" },
        { name: "markedit", version: "1.33.1" },
        { name: "mori", version: "0.7.0" },
        { name: "muxy", version: "1.3.0" },
        { name: "orbstack", version: "2.2.1,20628" },
        { name: "slack", version: "4.51.185" },
        { name: "stolendata-mpv", version: "0.40.0" },
        { name: "transmission", version: "4.1.3" },
        { name: "visual-studio-code", version: "1.133.0" },
      ]);
    }),
);

it.effect("brew-cask backend uses `brew install --cask`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeBrewCaskBackend();
    yield* backend.install("orbstack", undefined, capturingExec("", calls), NONE);
    expect(calls).toEqual(["brew install --cask orbstack"]);
  }),
);

it.effect("brew repo backend listRepos parses `brew tap` output into BrewRepo specs", () =>
  Effect.gen(function* () {
    const backend = makeBrewRepoBackend();
    const repos = yield* backend.listRepos(fakeExec("homebrew/cask\ncan1357/tap\n"));
    expect(repos).toEqual([
      { _tag: "Brew", tap: "homebrew/cask" },
      { _tag: "Brew", tap: "can1357/tap" },
    ]);
  }),
);

it.effect("brew repo backend addRepo shells out to `brew tap <tap>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeBrewRepoBackend();
    yield* backend.addRepo({ _tag: "Brew", tap: "can1357/tap" }, capturingExec("", calls), NONE);
    expect(calls).toEqual(["brew tap can1357/tap"]);
  }),
);

it.effect("apt backend parses dpkg-query output into package names and versions", () =>
  Effect.gen(function* () {
    const backend = makeAptBackend();
    const installed = yield* backend.list(fakeExec("curl\t8.5.0-2ubuntu10\ngit\t1:2.43.0-1\n"));
    expect(installed).toEqual([
      { name: "curl", version: "8.5.0-2ubuntu10" },
      { name: "git", version: "1:2.43.0-1" },
    ]);
  }),
);

it.effect(
  "apt backend install pins an exact version with `pkg=version`, sudo-prefixed under privilege sudo",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const backend = makeAptBackend();
      yield* backend.install(
        "tree",
        { _tag: "Exact", version: "2.1.1-2ubuntu3" },
        capturingExec("", calls),
        SUDO,
      );
      expect(calls).toEqual(["sudo apt-get install -y tree=2.1.1-2ubuntu3"]);
    }),
);

it.effect("apt backend install under privilege none runs unprefixed — no sudo binary assumed", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeAptBackend();
    yield* backend.install(
      "tree",
      { _tag: "Exact", version: "2.1.1-2ubuntu3" },
      capturingExec("", calls),
      NONE,
    );
    expect(calls).toEqual(["apt-get install -y tree=2.1.1-2ubuntu3"]);
  }),
);

it.effect(
  "apt backend refreshIndex shells out to `apt-get update`, sudo-prefixed under privilege sudo",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const backend = makeAptBackend();
      yield* backend.refreshIndex?.(capturingExec("", calls), SUDO) ?? Effect.void;
      expect(calls).toEqual(["sudo apt-get update"]);
    }),
);

it.effect("apt backend refreshIndex under privilege none runs unprefixed", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeAptBackend();
    yield* backend.refreshIndex?.(capturingExec("", calls), NONE) ?? Effect.void;
    expect(calls).toEqual(["apt-get update"]);
  }),
);

it.effect("apt repo backend listRepos parses one-line sources into AptRepo specs", () =>
  Effect.gen(function* () {
    const backend = makeAptRepoBackend();
    // Real shape verified by `apt-sources.test.ts`'s parser tests — this only
    // exercises the repo backend's own wrapping of that parser's output.
    const repos = yield* backend.listRepos(
      fakeExec(
        "deb http://ppa.launchpadcontent.net/git-core/ppa/ubuntu noble main\n###machine-run:deb822###\n",
      ),
    );
    expect(repos).toEqual([
      { _tag: "Apt", ppa: "ppa:git-core/ppa" },
      { _tag: "Apt", ppa: "deb http://ppa.launchpadcontent.net/git-core/ppa/ubuntu noble main" },
    ]);
  }),
);

it.effect(
  "apt repo backend addRepo shells out to `sudo add-apt-repository -y <ppa>` under privilege sudo",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const backend = makeAptRepoBackend();
      yield* backend.addRepo(
        { _tag: "Apt", ppa: "ppa:git-core/ppa" },
        capturingExec("", calls),
        SUDO,
      );
      expect(calls).toEqual(["sudo add-apt-repository -y ppa:git-core/ppa"]);
    }),
);

it.effect("apt repo backend addRepo under privilege none runs unprefixed", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeAptRepoBackend();
    yield* backend.addRepo(
      { _tag: "Apt", ppa: "ppa:git-core/ppa" },
      capturingExec("", calls),
      NONE,
    );
    expect(calls).toEqual(["add-apt-repository -y ppa:git-core/ppa"]);
  }),
);

it.effect("port backend parses `port installed` output into names and versions", () =>
  Effect.gen(function* () {
    const backend = makePortBackend();
    const installed = yield* backend.list(
      fakeExec(
        "The following ports are currently installed:\n  git @2.43.0_0 (active)\n  wget @1.24.5_0 (active)\n",
      ),
    );
    expect(installed).toEqual([
      { name: "git", version: "2.43.0_0" },
      { name: "wget", version: "1.24.5_0" },
    ]);
  }),
);

it.effect(
  "port backend refuses a version pin — never independently verified against a real port",
  () =>
    Effect.gen(function* () {
      const backend = makePortBackend();
      const result = yield* backend
        .install("git", { _tag: "Exact", version: "2.43.0_0" }, fakeExec(""), NONE)
        .pipe(Effect.flip);
      expect(result._tag).toBe("UnsupportedVersionSpec");
    }),
);

it.effect(
  "port backend install shells out to `sudo port install <name>` under privilege sudo",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const backend = makePortBackend();
      yield* backend.install("git", undefined, capturingExec("", calls), SUDO);
      expect(calls).toEqual(["sudo port install git"]);
    }),
);

it.effect("port backend install under privilege none runs unprefixed", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makePortBackend();
    yield* backend.install("git", undefined, capturingExec("", calls), NONE);
    expect(calls).toEqual(["port install git"]);
  }),
);

it.effect(
  "port backend refreshIndex shells out to `sudo port selfupdate` under privilege sudo",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const backend = makePortBackend();
      yield* backend.refreshIndex?.(capturingExec("", calls), SUDO) ?? Effect.void;
      expect(calls).toEqual(["sudo port selfupdate"]);
    }),
);

it.effect("port backend refreshIndex under privilege none runs unprefixed", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makePortBackend();
    yield* backend.refreshIndex?.(capturingExec("", calls), NONE) ?? Effect.void;
    expect(calls).toEqual(["port selfupdate"]);
  }),
);

it.effect(
  "cargo backend ignores indented binary lines from --list, and reports each crate's version",
  () =>
    Effect.gen(function* () {
      const backend = makeCargoBackend();
      const installed = yield* backend.list(
        fakeExec("cargo-bloat v0.11.1:\n    cargo-bloat\nripgrep v14.0.0:\n    rg\n"),
      );
      expect(installed).toEqual([
        { name: "cargo-bloat", version: "0.11.1" },
        { name: "ripgrep", version: "14.0.0" },
      ]);
    }),
);

it.effect("cargo backend install pins an exact version with `--version`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeCargoBackend();
    yield* backend.install(
      "just",
      { _tag: "Exact", version: "1.5.0" },
      capturingExec("", calls),
      NONE,
    );
    expect(calls).toEqual(["cargo install just --version 1.5.0"]);
  }),
);

it.effect("npm backend parses `npm ls -g --json` dependencies, including each one's version", () =>
  Effect.gen(function* () {
    const backend = makeNpmBackend();
    const installed = yield* backend.list(
      fakeExec(
        toJsonText({
          dependencies: { typescript: { version: "5.9.3" }, pnpm: { version: "10.0.0" } },
        }),
      ),
    );
    expect(installed.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "pnpm", version: "10.0.0" },
      { name: "typescript", version: "5.9.3" },
    ]);
  }),
);

it.effect("npm backend install pins an exact version with `pkg@version`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeNpmBackend();
    yield* backend.install(
      "cowsay",
      { _tag: "Exact", version: "1.5.0" },
      capturingExec("", calls),
      NONE,
    );
    expect(calls).toEqual(["npm install -g cowsay@1.5.0"]);
  }),
);

it.effect("npm backend surfaces a typed BackendParseError on malformed JSON", () =>
  Effect.gen(function* () {
    const backend = makeNpmBackend();
    const result = yield* Effect.flip(backend.list(fakeExec("not json")));
    expect(result._tag).toBe("BackendParseError");
  }),
);

it.effect(
  "npm backend forces the list command to exit 0, so ELSPROBLEMS can never discard stdout",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const backend = makeNpmBackend();
      yield* backend.list(capturingExec("{}", calls));
      expect(calls).toEqual(["npm ls -g --depth=0 --json; true"]);
    }),
);

it.effect(
  "npm backend still parses dependencies out of real ELSPROBLEMS output (extra problems/error keys, unmet dependency)",
  () =>
    Effect.gen(function* () {
      // Real captured `npm ls --depth=0 --json` stdout (npm 11.17.0) from a
      // project with an unmet dependency — reproduces the same shape
      // `npm ls -g` takes on an unmet peer dependency: npm still emits the
      // complete listing on stdout and exits 1 (`ELSPROBLEMS`) on the side.
      const realElsproblemsOutput = toJsonText({
        version: "1.0.0",
        name: "peer-test",
        problems: ["missing: real-pkg@1.0.0, required by peer-test@1.0.0"],
        dependencies: {
          "has-peer-dep": { version: "1.0.0", overridden: false },
          "real-pkg": {
            required: "1.0.0",
            missing: true,
            problems: ["missing: real-pkg@1.0.0, required by peer-test@1.0.0"],
          },
        },
        error: {
          code: "ELSPROBLEMS",
          summary: "missing: real-pkg@1.0.0, required by peer-test@1.0.0",
          detail: "",
        },
      });
      const backend = makeNpmBackend();
      const installed = yield* backend.list(fakeExec(realElsproblemsOutput));
      expect(installed.map((e) => e.name).sort()).toEqual(["has-peer-dep", "real-pkg"]);
    }),
);

it.effect("npm backend install shells out to `npm install -g <name>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeNpmBackend();
    yield* backend.install("typescript", undefined, capturingExec("", calls), NONE);
    expect(calls).toEqual(["npm install -g typescript"]);
  }),
);

// ---------------------------------------------------------------------------
// Dnf.ts / Pacman.ts — verified against real `fedora:latest` /
// `archlinux:latest` containers (see their module doc comments).
// ---------------------------------------------------------------------------

it.effect("dnf backend parses `dnf repoquery --userinstalled` output into names", () =>
  Effect.gen(function* () {
    const backend = makeDnfBackend();
    // Real captured output from `docker run --rm fedora:latest` (Fedora 44 /
    // dnf5) after `dnf install -y tree`.
    const installed = yield* backend.list(
      fakeExec(
        [
          "bash",
          "bzip2",
          "coreutils",
          "dnf5",
          "dnf5-plugins",
          "fedora-release-container",
          "filesystem",
          "gawk",
          "glibc-minimal-langpack",
          "gzip",
          "rootfiles",
          "rpm",
          "shadow-utils",
          "sudo",
          "systemd-standalone-sysusers",
          "tar",
          "tree",
          "tzdata",
          "util-linux-core",
          "vim-minimal",
          "xz",
          "zstd",
          "",
        ].join("\n"),
      ),
    );
    const names = installed.map((e) => e.name);
    expect(names).toContain("tree");
    expect(names).toContain("dnf5");
    expect(installed.length).toBe(22);
  }),
);

it.effect(
  "dnf backend install shells out to `sudo dnf install -y <name>` under privilege sudo",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const backend = makeDnfBackend();
      yield* backend.install("tree", undefined, capturingExec("", calls), SUDO);
      expect(calls).toEqual(["sudo dnf install -y tree"]);
    }),
);

it.effect("dnf backend install under privilege none runs unprefixed", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeDnfBackend();
    yield* backend.install("tree", undefined, capturingExec("", calls), NONE);
    expect(calls).toEqual(["dnf install -y tree"]);
  }),
);

it.effect(
  "dnf backend install pins an exact NEVRA with `name-evr`, sudo-prefixed under privilege sudo",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const backend = makeDnfBackend();
      yield* backend.install(
        "tree",
        { _tag: "Exact", version: "2.2.1-4.fc44" },
        capturingExec("", calls),
        SUDO,
      );
      expect(calls).toEqual(["sudo dnf install -y tree-2.2.1-4.fc44"]);
    }),
);

it.effect(
  "dnf backend refreshIndex shells out to `dnf makecache`, sudo-prefixed under privilege sudo",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const backend = makeDnfBackend();
      yield* backend.refreshIndex?.(capturingExec("", calls), SUDO) ?? Effect.void;
      expect(calls).toEqual(["sudo dnf makecache"]);
    }),
);

it.effect("dnf backend refreshIndex under privilege none runs unprefixed", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeDnfBackend();
    yield* backend.refreshIndex?.(capturingExec("", calls), NONE) ?? Effect.void;
    expect(calls).toEqual(["dnf makecache"]);
  }),
);

it.effect(
  "dnf repo backend listRepos parses `dnf copr list`, reporting both hub-qualified and bare forms",
  () =>
    Effect.gen(function* () {
      const backend = makeDnfRepoBackend();
      // Real captured output from the same container after
      // `dnf copr enable -y atim/lazygit`.
      const repos = yield* backend.listRepos(fakeExec("copr.fedorainfracloud.org/atim/lazygit\n"));
      expect(repos).toEqual([
        { _tag: "Dnf", project: "copr.fedorainfracloud.org/atim/lazygit" },
        { _tag: "Dnf", project: "atim/lazygit" },
      ]);
    }),
);

it.effect(
  "dnf repo backend addRepo shells out to `sudo dnf copr enable -y <project>` under privilege sudo",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const backend = makeDnfRepoBackend();
      yield* backend.addRepo(
        { _tag: "Dnf", project: "atim/lazygit" },
        capturingExec("", calls),
        SUDO,
      );
      expect(calls).toEqual(["sudo dnf copr enable -y atim/lazygit"]);
    }),
);

it.effect("dnf repo backend addRepo under privilege none runs unprefixed", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeDnfRepoBackend();
    yield* backend.addRepo(
      { _tag: "Dnf", project: "atim/lazygit" },
      capturingExec("", calls),
      NONE,
    );
    expect(calls).toEqual(["dnf copr enable -y atim/lazygit"]);
  }),
);

it.effect("pacman backend parses `pacman -Qq` output into names", () =>
  Effect.gen(function* () {
    const backend = makePacmanBackend();
    // Real captured (truncated) output from
    // `docker run --rm --platform linux/amd64 archlinux:latest` — a fresh
    // image's own base packages, with the `warning: database file for '...'
    // does not exist` lines pacman prints to stderr (verified separately,
    // never stdout) already excluded.
    const installed = yield* backend.list(
      fakeExec(
        [
          "acl",
          "archlinux-keyring",
          "attr",
          "audit",
          "base",
          "bash",
          "binutils",
          "brotli",
          "bzip2",
          "ca-certificates",
          "ca-certificates-mozilla",
          "ca-certificates-utils",
          "coreutils",
          "cryptsetup",
          "curl",
          "dbus",
          "dbus-broker",
          "dbus-broker-units",
          "dbus-units",
          "device-mapper",
          "e2fsprogs",
          "expat",
          "file",
          "filesystem",
          "findutils",
          "gawk",
          "gcc-libs",
          "gdbm",
          "",
        ].join("\n"),
      ),
    );
    const names = installed.map((e) => e.name);
    expect(names).toContain("base");
    expect(names).toContain("bash");
    expect(installed.length).toBe(28);
  }),
);

it.effect("pacman backend list parses `pacman -Q` name+version pairs", () =>
  Effect.gen(function* () {
    const backend = makePacmanBackend();
    const installed = yield* backend.list(fakeExec("tree 2.3.2-1\nbash 5.2.32-1\n"));
    expect(installed).toEqual([
      { name: "tree", version: "2.3.2-1" },
      { name: "bash", version: "5.2.32-1" },
    ]);
  }),
);

it.effect(
  "pacman backend install shells out to `sudo pacman -S --noconfirm <name>` under privilege sudo",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const backend = makePacmanBackend();
      yield* backend.install("tree", undefined, capturingExec("", calls), SUDO);
      expect(calls).toEqual(["sudo pacman -S --noconfirm tree"]);
    }),
);

it.effect("pacman backend install under privilege none runs unprefixed", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makePacmanBackend();
    yield* backend.install("tree", undefined, capturingExec("", calls), NONE);
    expect(calls).toEqual(["pacman -S --noconfirm tree"]);
  }),
);

it.effect(
  "pacman backend refuses to attempt a version pin its own reconciler already knows it cannot honour on downgrade — Package.ts's CannotDowngrade, not this backend",
  () =>
    Effect.gen(function* () {
      // pacman's own backend still ACCEPTS an `Exact` spec at the install
      // seam (its official repo genuinely can hold the current version) —
      // it is `Package.ts`'s `apply` that must refuse to even try moving
      // backward, using `pacmanVersionSupport.canDowngrade === false`. See
      // the `Package reconciler apply: fails with CannotDowngrade` test
      // below for that guard exercised directly.
      const calls: string[] = [];
      const backend = makePacmanBackend();
      yield* backend.install(
        "tree",
        { _tag: "Exact", version: "2.3.2-1" },
        capturingExec("", calls),
        NONE,
      );
      expect(calls).toEqual(["pacman -S --noconfirm tree=2.3.2-1"]);
    }),
);

it.effect(
  "pacman backend refreshIndex shells out to `pacman -Sy`, deliberately not `-Syu`, sudo-prefixed under privilege sudo",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const backend = makePacmanBackend();
      yield* backend.refreshIndex?.(capturingExec("", calls), SUDO) ?? Effect.void;
      expect(calls).toEqual(["sudo pacman -Sy --noconfirm"]);
    }),
);

it.effect("pacman backend refreshIndex under privilege none runs unprefixed", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makePacmanBackend();
    yield* backend.refreshIndex?.(capturingExec("", calls), NONE) ?? Effect.void;
    expect(calls).toEqual(["pacman -Sy --noconfirm"]);
  }),
);

// ---------------------------------------------------------------------------
// Aur.ts (yay/paru) — verified against `archlinux:latest`: a real AUR build
// (yay-bin, from https://aur.archlinux.org/yay-bin.git) installed cleanly,
// `yay -S --noconfirm cmatrix` (an official-repo package) delegated straight
// to pacman, and `pacman -Qmq` afterwards listed only the AUR-origin
// yay-bin/yay-bin-debug — never cmatrix.
// ---------------------------------------------------------------------------

it.effect(
  "yay/paru backends list AUR-origin packages via `pacman -Qmq`, not their own binary",
  () =>
    Effect.gen(function* () {
      const yayCalls: string[] = [];
      const paruCalls: string[] = [];
      // Real captured `pacman -Qmq` output after building yay-bin from the AUR.
      const installedYay = yield* makeYayBackend().list(
        capturingExec("yay-bin 1.4.0-1\nyay-bin-debug 1.4.0-1\n", yayCalls),
      );
      const installedParu = yield* makeParuBackend().list(
        capturingExec("yay-bin 1.4.0-1\nyay-bin-debug 1.4.0-1\n", paruCalls),
      );
      expect(installedYay).toEqual([
        { name: "yay-bin", version: "1.4.0-1" },
        { name: "yay-bin-debug", version: "1.4.0-1" },
      ]);
      expect(installedParu).toEqual([
        { name: "yay-bin", version: "1.4.0-1" },
        { name: "yay-bin-debug", version: "1.4.0-1" },
      ]);
      expect(yayCalls).toEqual(["pacman -Qm"]);
      expect(paruCalls).toEqual(["pacman -Qm"]);
    }),
);

it.effect("yay backend install shells out to `yay -S --noconfirm <name>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    yield* makeYayBackend().install("downgrade", undefined, capturingExec("", calls), NONE);
    expect(calls).toEqual(["yay -S --noconfirm downgrade"]);
  }),
);

it.effect("paru backend install shells out to `paru -S --noconfirm <name>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    yield* makeParuBackend().install("downgrade", undefined, capturingExec("", calls), NONE);
    expect(calls).toEqual(["paru -S --noconfirm downgrade"]);
  }),
);

it.effect("yay backend refreshIndex shells out to `yay -Sy --noconfirm`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    yield* makeYayBackend().refreshIndex?.(capturingExec("", calls), NONE) ?? Effect.void;
    expect(calls).toEqual(["yay -Sy --noconfirm"]);
  }),
);

// ---------------------------------------------------------------------------
// New backends verified locally on this machine: pipx, uv tool, gem,
// go install, mas.
// ---------------------------------------------------------------------------

it("parsePipxList extracts the name and version from real `pipx list --short` output, ignoring the empty-state banner", () => {
  // Real captured output (pipx 1.16.6, installed via `brew install pipx`):
  // populated after `pipx install cowsay`, and the friendly banner pipx
  // prints instead of empty output on a fresh install.
  expect(parsePipxList("cowsay 6.1\n")).toEqual([{ name: "cowsay", version: "6.1" }]);
  expect(parsePipxList("nothing has been installed with pipx 😴\n")).toEqual([]);
});

it.effect("pipx backend install shells out to `pipx install <name>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    yield* makePipxBackend().install("cowsay", undefined, capturingExec("", calls), NONE);
    expect(calls).toEqual(["pipx install cowsay"]);
  }),
);

it.effect(
  "pipx backend install pins an exact version with `pkg==version --force`, verified against a real refusal without it",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      yield* makePipxBackend().install(
        "cowsay",
        { _tag: "Exact", version: "5.0" },
        capturingExec("", calls),
        NONE,
      );
      expect(calls).toEqual(["pipx install --force cowsay==5.0"]);
    }),
);

it("parseUvToolList extracts the name and version from real `uv tool list` output, ignoring the empty-state message", () => {
  // Real captured output (uv 0.12.2, already installed on this machine):
  // populated after `uv tool install cowsay`, byte-verified with `sed -n
  // 'l'` to confirm the executable sub-line has no leading indentation
  // (unlike Cargo's), and the empty-state message.
  expect(parseUvToolList("cowsay v6.1\n- cowsay\n")).toEqual([{ name: "cowsay", version: "6.1" }]);
  expect(parseUvToolList("No tools installed\n")).toEqual([]);
});

it.effect("uv-tool backend install shells out to `uv tool install <name>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    yield* makeUvToolBackend().install("cowsay", undefined, capturingExec("", calls), NONE);
    expect(calls).toEqual(["uv tool install cowsay"]);
  }),
);

it.effect("uv-tool backend install pins an exact version with `pkg==version --force`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    yield* makeUvToolBackend().install(
      "cowsay",
      { _tag: "Exact", version: "5.0" },
      capturingExec("", calls),
      NONE,
    );
    expect(calls).toEqual(["uv tool install --force cowsay==5.0"]);
  }),
);

it.effect(
  "gem backend parses real `gem list --local` output, including multi-version and default-gem lines",
  () =>
    Effect.gen(function* () {
      // Real captured output (macOS system Ruby 2.6.10): a bundled default
      // gem, and a gem installed at three different versions via two
      // `gem install --user-install rake -v ...` calls.
      const backend = makeGemBackend();
      const installed = yield* backend.list(
        fakeExec("bigdecimal (default: 1.4.1)\nrake (13.4.2, 13.0.6, 12.3.3)\n"),
      );
      expect(installed).toEqual([
        { name: "bigdecimal", version: "1.4.1" },
        { name: "rake", version: "13.4.2" },
      ]);
    }),
);

it.effect("gem backend install shells out to `gem install --user-install <name>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeGemBackend();
    yield* backend.install("rake", undefined, capturingExec("", calls), NONE);
    expect(calls).toEqual(["gem install --user-install rake"]);
  }),
);

it.effect("gem backend install pins an exact version with `-v`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeGemBackend();
    yield* backend.install(
      "rake",
      { _tag: "Exact", version: "13.0.6" },
      capturingExec("", calls),
      NONE,
    );
    expect(calls).toEqual(["gem install --user-install rake -v 13.0.6"]);
  }),
);

it("parseGoVersionM extracts import paths and versions from real `go version -m <bin>/*` output", () => {
  // Real captured output (macOS, go 1.26.5) after
  // `go install golang.org/x/tools/cmd/goimports@latest` and
  // `...cmd/stringer@latest` — one header + build-info block per binary; the
  // `path` line names the binary's own import path, and the `mod` line right
  // beneath it (module path + version) is what `PackageEntry.version` now
  // reports.
  const realOutput = [
    "/Users/a/go/bin/goimports: go1.26.5",
    "\tpath\tgolang.org/x/tools/cmd/goimports",
    "\tmod\tgolang.org/x/tools\tv0.48.0\th1:abc=",
    "/Users/a/go/bin/stringer: go1.26.5",
    "\tpath\tgolang.org/x/tools/cmd/stringer",
    "\tmod\tgolang.org/x/tools\tv0.48.0\th1:abc=",
    "",
  ].join("\n");
  expect(parseGoVersionM(realOutput)).toEqual([
    { name: "golang.org/x/tools/cmd/goimports", version: "v0.48.0" },
    { name: "golang.org/x/tools/cmd/stringer", version: "v0.48.0" },
  ]);
  // An empty/nonexistent bin directory: the unquoted glob doesn't expand and
  // `go version -m` fails on the literal `*`, all on stderr — this backend's
  // command discards that (`2>/dev/null; true`), so `list` only ever sees
  // empty stdout here.
  expect(parseGoVersionM("")).toEqual([]);
});

it.effect("go-install backend install shells out to `go install <name>@latest`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeGoBackend();
    yield* backend.install(
      "golang.org/x/tools/cmd/goimports",
      undefined,
      capturingExec("", calls),
      NONE,
    );
    expect(calls).toEqual(["go install golang.org/x/tools/cmd/goimports@latest"]);
  }),
);

it.effect("go-install backend install pins an exact version with `path@version`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeGoBackend();
    yield* backend.install(
      "golang.org/x/tools/cmd/goimports",
      { _tag: "Exact", version: "v0.20.0" },
      capturingExec("", calls),
      NONE,
    );
    expect(calls).toEqual(["go install golang.org/x/tools/cmd/goimports@v0.20.0"]);
  }),
);

it.effect(
  "mas backend parses real `mas list` output, taking the numeric App Store id and version",
  () =>
    Effect.gen(function* () {
      // Real captured output from this machine's own (signed-in) `mas list`,
      // re-captured this session as `test/fixtures/mas-list.txt` (now seven
      // apps, up from three) — the id column's width varies
      // (leading-space-padded), so this is also a real exercise of
      // `firstTokens` after `lines()`'s trim, not a fixed-width parse. The
      // trailing `(<version>)` is reported for observability only — `mas` has
      // no version-pinning mechanism at all (see `Mas.ts`'s `versions`).
      const backend = makeMasBackend();
      const installed = yield* backend.list(fakeExec(fixture("mas-list.txt")));
      expect(installed).toEqual([
        { name: "937984704", version: "5.3.2" },
        { name: "640199958", version: "11.0.2" },
        { name: "361304891", version: "15.1" },
        { name: "490179405", version: "9.67.1" },
        { name: "361309726", version: "15.1.1" },
        { name: "899247664", version: "4.3.0" },
        { name: "6757482822", version: "2.14" },
      ]);
    }),
);

it.effect("mas backend install shells out to `sudo mas install <id>` under privilege sudo", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeMasBackend();
    yield* backend.install("937984704", undefined, capturingExec("", calls), SUDO);
    expect(calls).toEqual(["sudo mas install 937984704"]);
  }),
);

it.effect("mas backend install under privilege none runs unprefixed", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeMasBackend();
    yield* backend.install("937984704", undefined, capturingExec("", calls), NONE);
    expect(calls).toEqual(["mas install 937984704"]);
  }),
);

it.effect("mas backend refuses a version pin — mas has no version concept at all", () =>
  Effect.gen(function* () {
    const backend = makeMasBackend();
    const result = yield* backend
      .install("937984704", { _tag: "Exact", version: "5.3.2" }, fakeExec(""), NONE)
      .pipe(Effect.flip);
    expect(result._tag).toBe("UnsupportedVersionSpec");
  }),
);

it.effect("flatpak backend list returns [] on a real empty listing", () =>
  Effect.gen(function* () {
    // Real captured output from `docker run --rm ubuntu:24.04` (flatpak
    // 1.14.6, freshly installed, no apps): `flatpak list --app
    // --columns=application` printed nothing and exited 0.
    const backend = makeFlatpakBackend();
    const installed = yield* backend.list(fakeExec(""));
    expect(installed).toEqual([]);
  }),
);

it.effect("flatpak backend install shells out to `flatpak install -y --noninteractive <id>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeFlatpakBackend();
    yield* backend.install("org.gnome.Calculator", undefined, capturingExec("", calls), NONE);
    expect(calls).toEqual(["flatpak install -y --noninteractive org.gnome.Calculator"]);
  }),
);

it.effect(
  "flatpak backend install pins a branch with `id//branch`, flatpak's own double-slash syntax",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const backend = makeFlatpakBackend();
      yield* backend.install(
        "org.gnome.Platform",
        { _tag: "Channel", name: "45" },
        capturingExec("", calls),
        NONE,
      );
      expect(calls).toEqual(["flatpak install -y --noninteractive org.gnome.Platform//45"]);
    }),
);

it.effect(
  "flatpak backend refuses an Exact pin — a flatpak app has no version history to request by string",
  () =>
    Effect.gen(function* () {
      const backend = makeFlatpakBackend();
      const result = yield* backend
        .install("org.gnome.Calculator", { _tag: "Exact", version: "45.0" }, fakeExec(""), NONE)
        .pipe(Effect.flip);
      expect(result._tag).toBe("UnsupportedVersionSpec");
    }),
);

it.effect(
  "flatpak repo backend listRepos returns [] on a real empty `flatpak remotes` listing",
  () =>
    Effect.gen(function* () {
      // Real captured output from `docker run --rm --platform linux/amd64
      // ubuntu:24.04` (flatpak 1.14.6, freshly installed, no remotes):
      // `flatpak remotes --columns=name,url` prints one blank line (not zero
      // bytes) and exits 0 — see `Flatpak.ts`'s `listRepos` doc comment.
      const backend = makeFlatpakRepoBackend();
      const repos = yield* backend.listRepos(fakeExec(fixture("flatpak-remotes-empty.txt")));
      expect(repos).toEqual([]);
    }),
);

it.effect(
  "flatpak repo backend listRepos returns both a bare-name entry and a name+location entry " +
    "on a real populated `flatpak remotes` listing",
  () =>
    Effect.gen(function* () {
      // Real captured output after `flatpak remote-add --if-not-exists
      // flathub https://dl.flathub.org/repo/flathub.flatpakrepo` and the
      // equivalent `flathub-beta` call, same container as above. Note the
      // resolved URLs (`https://dl.flathub.org/repo/`,
      // `https://dl.flathub.org/beta-repo/`) differ from the bootstrap
      // `.flatpakrepo` URLs that were actually passed to `remote-add` — see
      // `Flatpak.ts`'s doc comment for why that's a real, unavoidable
      // limitation, not a parsing bug.
      const backend = makeFlatpakRepoBackend();
      const repos = yield* backend.listRepos(fakeExec(fixture("flatpak-remotes.txt")));
      expect(repos).toEqual([
        { _tag: "Flatpak", name: "flathub" },
        { _tag: "Flatpak", name: "flathub", location: "https://dl.flathub.org/repo/" },
        { _tag: "Flatpak", name: "flathub-beta" },
        { _tag: "Flatpak", name: "flathub-beta", location: "https://dl.flathub.org/beta-repo/" },
      ]);
    }),
);

it.effect(
  "flatpak repo backend addRepo shells out to `flatpak remote-add --if-not-exists <name> <location>`",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const backend = makeFlatpakRepoBackend();
      yield* backend.addRepo(
        {
          _tag: "Flatpak",
          name: "flathub",
          location: "https://dl.flathub.org/repo/flathub.flatpakrepo",
        },
        capturingExec("", calls),
        NONE,
      );
      expect(calls).toEqual([
        "flatpak remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo",
      ]);
    }),
);

it.effect(
  "flatpak repo backend addRepo fails with BackendParseError on a repo with no location, " +
    "before running anything",
  () =>
    Effect.gen(function* () {
      const backend = makeFlatpakRepoBackend();
      const calls: string[] = [];
      const error = yield* backend
        .addRepo({ _tag: "Flatpak", name: "flathub" }, capturingExec("", calls), NONE)
        .pipe(Effect.flip);
      expect(error._tag).toBe("BackendParseError");
      expect(calls).toEqual([]);
    }),
);

it.effect("snap backend list returns [] on a real empty listing", () =>
  Effect.gen(function* () {
    // Real captured behaviour from a genuinely booted systemd+snapd
    // container (docker run --privileged --cgroupns=host, see Snap.ts's doc
    // comment): a fresh install's "No snaps are installed yet." message goes
    // to stderr, never stdout, so `exec`'s stdout really is empty here.
    const backend = makeSnapBackend();
    const installed = yield* backend.list(fakeExec(""));
    expect(installed).toEqual([]);
  }),
);

it.effect("snap backend list parses real `snap list` output (systemd-booted container)", () =>
  Effect.gen(function* () {
    // Real captured output after `snap install hello-world` in the same
    // container — see Snap.ts's doc comment for the full session, including
    // snapd's own first-install bootstrap (pulling the `snapd`/`core` base
    // snaps and restarting itself mid-install) and confirmation that the
    // installed snap actually ran (`snap run hello-world` → "Hello World!").
    const backend = makeSnapBackend();
    const installed = yield* backend.list(fakeExec(fixture("snap-list.txt")));
    // `version` reports the `Tracking` column (the channel a snap actually
    // follows), never the `Version` column — see `Snap.ts`'s `list` doc
    // comment for why: a channel pin compares against which channel a snap
    // follows, not the publisher's own release string for that revision.
    expect(installed).toEqual([
      { name: "core", version: "latest/stable" },
      { name: "hello-world", version: "latest/stable" },
      { name: "snapd", version: "latest/stable" },
    ]);
  }),
);

it.effect(
  "snap backend install shells out to `sudo snap install <name>` under privilege sudo",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const backend = makeSnapBackend();
      yield* backend.install("hello-world", undefined, capturingExec("", calls), SUDO);
      expect(calls).toEqual(["sudo snap install hello-world"]);
    }),
);

it.effect("snap backend install under privilege none runs unprefixed", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeSnapBackend();
    yield* backend.install("hello-world", undefined, capturingExec("", calls), NONE);
    expect(calls).toEqual(["snap install hello-world"]);
  }),
);

it.effect(
  "snap backend install pins a channel with `--channel=`, sudo-prefixed under privilege sudo",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const backend = makeSnapBackend();
      yield* backend.install(
        "hello-world",
        { _tag: "Channel", name: "latest/edge" },
        capturingExec("", calls),
        SUDO,
      );
      expect(calls).toEqual(["sudo snap install hello-world --channel=latest/edge"]);
    }),
);

it.effect("snap backend install pins a channel under privilege none, unprefixed", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeSnapBackend();
    yield* backend.install(
      "hello-world",
      { _tag: "Channel", name: "latest/edge" },
      capturingExec("", calls),
      NONE,
    );
    expect(calls).toEqual(["snap install hello-world --channel=latest/edge"]);
  }),
);

it.effect(
  "snap backend refuses an Exact pin — a snap has no version history to request by string",
  () =>
    Effect.gen(function* () {
      const backend = makeSnapBackend();
      const result = yield* backend
        .install("hello-world", { _tag: "Exact", version: "6.4" }, fakeExec(""), NONE)
        .pipe(Effect.flip);
      expect(result._tag).toBe("UnsupportedVersionSpec");
    }),
);

// ---------------------------------------------------------------------------
// parse.ts helpers
// ---------------------------------------------------------------------------

it("lines() trims and drops blank lines, never yielding undefined", () => {
  expect(lines("curl\n\n  git  \n\t\n")).toEqual(["curl", "git"]);
  expect(lines("")).toEqual([]);
});

it("firstTokens() takes the first whitespace token of each already-trimmed candidate, skipping empties", () => {
  // Callers always run `lines()` first (which trims), so a candidate here
  // never has leading whitespace of its own — `firstTokens` only has to
  // split what's left.
  expect(firstTokens(["git @2.43.0_0 (active)", "wget @1.24.5_0"])).toEqual(["git", "wget"]);
  // A blank/whitespace-only candidate must never contribute a literal
  // `undefined` into the result — this is exactly the bug `noUncheckedIndexedAccess`
  // caught in the pre-parse.ts backends (see the module doc comment).
  expect(firstTokens(["   ", ""])).toEqual([]);
});

// ---------------------------------------------------------------------------
// bulk.ts's toId — distinct names must get distinct ids
// ---------------------------------------------------------------------------

it("toId leaves already-safe names untouched", () => {
  expect(toId("ripgrep")).toBe("ripgrep");
  expect(toId("cargo-bloat")).toBe("cargo-bloat");
});

it("toId gives `foo/bar` and `foo-bar` different ids instead of colliding", () => {
  const a = toId("foo/bar");
  const b = toId("foo-bar");
  expect(a).not.toBe(b);
  // The already-safe name is untouched (no hash suffix, no state churn for
  // the common case); only the sanitized one gets a disambiguating suffix.
  expect(b).toBe("foo-bar");
  expect(a).toMatch(/^foo-bar-[a-z0-9]+$/);
});

it("toId is stable across repeated calls (deterministic, not random)", () => {
  expect(toId("@opencode-ai/cli")).toBe(toId("@opencode-ai/cli"));
});

// ---------------------------------------------------------------------------
// Winget.ts / Choco.ts parsing
// ---------------------------------------------------------------------------

it("parseWingetList extracts the Id column, not the Name column", () => {
  // Columns are padded to a fixed width, which is what makes the multi-word
  // "Visual Studio Code" unambiguous: the space inside it is part of the Name,
  // and `Id` still begins at the same offset the header's `Id` does. Rows are
  // sliced at those offsets rather than split on whitespace, because winget
  // truncates an over-long cell with an ellipsis that leaves only a single
  // space before the next column — see Winget.ts and the captured fixture in
  // test/fixtures.
  const table = [
    "Name                Id                Version",
    "----------------------------------------------",
    "Git                 Git.Git           2.43.0",
    "Visual Studio Code  Microsoft.VSCode  1.85.0",
  ].join("\n");
  expect(parseWingetList(table)).toEqual([
    { name: "Git.Git", version: "2.43.0" },
    { name: "Microsoft.VSCode", version: "1.85.0" },
  ]);
});

it("parseWingetList returns [] when no separator row is found", () => {
  expect(parseWingetList("No installed package found matching input criteria.")).toEqual([]);
});

it.effect("parseWingetExport decodes real nested sources and preserves exported versions", () =>
  Effect.gen(function* () {
    const entries = yield* parseWingetExport(fixture("winget-export.json"));

    expect(entries).toContainEqual({ name: "Git.Git", version: "2.35.1.2" });
    expect(entries).toContainEqual({
      name: "Microsoft.VisualStudio.2022.Community",
      version: "17.1.3",
    });
    expect(entries).toHaveLength(44);
  }),
);

it.effect("winget backend exports to a quoted temporary path instead of parsing its table", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeWingetBackend();
    const installed = yield* backend.list(
      capturingExec("ignored stdout", calls),
      packageListContext(fixture("winget-export.json")),
    );

    expect(installed).toContainEqual({ name: "Git.Git", version: "2.35.1.2" });
    expect(calls).toEqual([
      "'winget' 'export' '--output' 'C:\\runner temp\\winget-export.json' '--include-versions' '--accept-source-agreements' '--disable-interactivity'",
    ]);
  }),
);

it.effect("winget inventory refuses an unscoped file export capability", () =>
  Effect.gen(function* () {
    const error = yield* makeWingetBackend().list(capturingExec("", [])).pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: "BackendParseError", manager: "winget export" });
  }),
);

it.effect("winget export rejects malformed output as a typed parse error", () =>
  Effect.gen(function* () {
    const error = yield* parseWingetExport("not json").pipe(Effect.flip);
    expect(error._tag).toBe("BackendParseError");
    expect(error.manager).toBe("winget export");
  }),
);

it.effect(
  "winget backend refreshIndex shells out to `winget source update` (UNVERIFIED, no Windows target)",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const backend = makeWingetBackend();
      yield* backend.refreshIndex?.(capturingExec("", calls), NONE) ?? Effect.void;
      expect(calls).toEqual(["'winget' 'source' 'update'"]);
    }),
);

it.effect("choco backend parses `name|version` limit-output lines into names and versions", () =>
  Effect.gen(function* () {
    const backend = makeChocoBackend();
    const installed = yield* backend.list(fakeExec("git|2.43.0\nnodejs-lts|20.11.0\n"));
    expect(installed).toEqual([
      { name: "git", version: "2.43.0" },
      { name: "nodejs-lts", version: "20.11.0" },
    ]);
  }),
);

it.effect(
  "choco backend install pins an exact version with `--version --allow-downgrade` (UNVERIFIED, no Windows target)",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const backend = makeChocoBackend();
      yield* backend.install(
        "git",
        { _tag: "Exact", version: "2.40.0" },
        capturingExec("", calls),
        NONE,
      );
      expect(calls).toEqual([
        "'choco' 'install' 'git' '--version' '2.40.0' '--allow-downgrade' '-y'",
      ]);
    }),
);

// ---------------------------------------------------------------------------
// Package.ts's reconciler: observe/matches/apply driven directly, with a
// fake `Exec` standing in for a real `CommandExecutor` — no alchemy engine,
// no fabricated session or bindings.
// ---------------------------------------------------------------------------

it.effect(
  "Package reconciler address is the manager id, so every package on one manager shares a lock",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makePackageReconciler;
      expect(reconciler.address({ manager: "brew", name: "ripgrep" })).toBe("brew");
      expect(reconciler.address({ manager: "brew", name: "fd" })).toBe("brew");
      expect(reconciler.address({ manager: "cargo", name: "ripgrep" })).toBe("cargo");
    }),
);

it.effect(
  "Package reconciler observe: Option.none() when the package is missing from a live listing",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makePackageReconciler;
      const observed = yield* reconciler.observe(
        { manager: "brew", name: "fd" },
        planCtx(fakeExec("ripgrep\n")),
      );
      expect(observed).toEqual(Option.none());
    }),
);

it.effect("Package reconciler observe: the package's state once a live listing includes it", () =>
  Effect.gen(function* () {
    const reconciler = yield* makePackageReconciler;
    const observed = yield* reconciler.observe(
      { manager: "brew", name: "ripgrep" },
      planCtx(fakeExec("ripgrep\nfd\n")),
    );
    expect(observed).toEqual(Option.some({ manager: "brew", name: "ripgrep" }));
  }),
);

it.effect("Package reconciler matches: true iff manager and name are both equal", () =>
  Effect.gen(function* () {
    const reconciler = yield* makePackageReconciler;
    // `PackageState`, not `PackageProps`: `matches` compares two *states*, and
    // since the version work those differ in more than name — a state's
    // `version` is the concrete string a listing reported, while a prop's is a
    // `VersionSpec`.
    const desired: PackageState = { manager: "brew", name: "ripgrep" };
    expect(reconciler.matches({ manager: "brew", name: "ripgrep" }, desired)).toBe(true);
    expect(reconciler.matches({ manager: "brew", name: "fd" }, desired)).toBe(false);
    expect(reconciler.matches({ manager: "cargo", name: "ripgrep" }, desired)).toBe(false);
  }),
);

it.effect("Package reconciler apply: installs the package and returns its state", () =>
  Effect.gen(function* () {
    const reconciler = yield* makePackageReconciler;
    const calls: string[] = [];
    const props: PackageProps = { manager: "brew", name: "fd" };
    const desired = yield* reconciler.desired(props);

    const result = yield* reconciler.apply(
      { props, observed: Option.none(), desired },
      applyCtx(capturingExec("", calls)),
    );

    expect(result).toEqual({ manager: "brew", name: "fd" });
    expect(calls).toEqual(["brew install fd"]);
  }),
);

it.effect(
  "Package reconciler desired: fails with UnsupportedVersionSpec for a manager that can't honour the pin",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makePackageReconciler;
      const props: PackageProps = {
        manager: "brew",
        name: "ripgrep",
        version: { _tag: "Exact", version: "14.0.0" },
      };
      const error = yield* reconciler.desired(props).pipe(Effect.flip);
      expect(error._tag).toBe("UnsupportedVersionSpec");
    }),
);

it.effect(
  "Package reconciler matches: ToSpec compares the pinned version, Never/unset ignores it once installed",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makePackageReconciler;
      // pacman genuinely accepts `Exact` (Pacman.ts's own versions.accepts),
      // so this exercises the real capability check, not a manager that
      // would reject the spec before `matches` is ever reached.
      const toSpecProps: PackageProps = {
        manager: "pacman",
        name: "tree",
        version: { _tag: "Exact", version: "2.3.2-1" },
        updatePolicy: { _tag: "ToSpec" },
      };
      const toSpecDesired = yield* reconciler.desired(toSpecProps);
      expect(
        reconciler.matches({ manager: "pacman", name: "tree", version: "2.3.2-1" }, toSpecDesired),
      ).toBe(true);
      expect(
        reconciler.matches({ manager: "pacman", name: "tree", version: "2.0.0-1" }, toSpecDesired),
      ).toBe(false);

      // Same pin, no `updatePolicy` (defaults to `Never`): once installed at
      // all, a different observed version is not drift — this is the stated
      // "install once, then leave version alone" default, not an accident.
      const neverProps: PackageProps = {
        manager: "pacman",
        name: "tree",
        version: { _tag: "Exact", version: "2.3.2-1" },
      };
      const neverDesired = yield* reconciler.desired(neverProps);
      expect(
        reconciler.matches({ manager: "pacman", name: "tree", version: "2.0.0-1" }, neverDesired),
      ).toBe(true);
    }),
);

it.effect("Package reconciler drift: empty exactly when matches is true", () =>
  Effect.gen(function* () {
    const reconciler = yield* makePackageReconciler;
    const props: PackageProps = {
      manager: "pacman",
      name: "tree",
      version: { _tag: "Exact", version: "2.3.2-1" },
      updatePolicy: { _tag: "ToSpec" },
    };
    const desired = yield* reconciler.desired(props);
    const drift = reconciler.drift;
    if (drift === undefined) return yield* Effect.die("Package reconciler must define drift");

    const matching: PackageState = { manager: "pacman", name: "tree", version: "2.3.2-1" };
    expect(reconciler.matches(matching, desired)).toBe(true);
    expect(drift(matching, desired)).toEqual([]);

    const mismatching: PackageState = { manager: "pacman", name: "tree", version: "2.0.0-1" };
    expect(reconciler.matches(mismatching, desired)).toBe(false);
    expect(drift(mismatching, desired).length).toBeGreaterThan(0);
  }),
);

it.effect(
  "Package reconciler drift: version direction is `behind`/`ahead` when compareVersions can order the pair, absent otherwise",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makePackageReconciler;
      const drift = reconciler.drift;
      if (drift === undefined) return yield* Effect.die("Package reconciler must define drift");

      const props: PackageProps = {
        manager: "pacman",
        name: "tree",
        version: { _tag: "Exact", version: "2.3.2-1" },
        updatePolicy: { _tag: "ToSpec" },
      };
      const desired = yield* reconciler.desired(props);

      // Both dotted-numeric (pacman's own `pkgver-pkgrel` shape) — ordered.
      expect(drift({ manager: "pacman", name: "tree", version: "2.0.0-1" }, desired)).toEqual([
        { field: "version", observed: "2.0.0-1", desired: "2.3.2-1", direction: "behind" },
      ]);
      expect(drift({ manager: "pacman", name: "tree", version: "2.5.0-1" }, desired)).toEqual([
        { field: "version", observed: "2.5.0-1", desired: "2.3.2-1", direction: "ahead" },
      ]);

      // An AUR VCS version (`r1235.cafebabe`) has no numeric grammar
      // `compareVersions` will order — `direction` must be absent, not guessed.
      const yayProps: PackageProps = {
        manager: "yay",
        name: "some-vcs-pkg",
        version: { _tag: "Exact", version: "r1234.deadbeef" },
        updatePolicy: { _tag: "ToSpec" },
      };
      const yayDesired = yield* reconciler.desired(yayProps);
      expect(
        drift({ manager: "yay", name: "some-vcs-pkg", version: "r1235.cafebabe" }, yayDesired),
      ).toEqual([{ field: "version", observed: "r1235.cafebabe", desired: "r1234.deadbeef" }]);
    }),
);

it.effect(
  "Package reconciler apply: fails with CannotDowngrade rather than attempting a pin pacman cannot honour backward",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makePackageReconciler;
      const calls: string[] = [];
      const props: PackageProps = {
        manager: "pacman",
        name: "tree",
        version: { _tag: "Exact", version: "2.0.0-1" },
        updatePolicy: { _tag: "ToSpec" },
      };
      const desired = yield* reconciler.desired(props);
      const observed = Option.some<PackageState>({
        manager: "pacman",
        name: "tree",
        version: "2.3.2-1",
      });

      const error = yield* reconciler
        .apply({ props, observed, desired }, applyCtx(capturingExec("", calls)))
        .pipe(Effect.flip);

      expect(error._tag).toBe("CannotDowngrade");
      expect(error).toMatchObject({ direction: "Ahead" });
      // Nothing was run — the guard fires before ever shelling out.
      expect(calls).toEqual([]);
    }),
);

it.effect(
  "Package reconciler apply: fails with CannotDowngrade on an Unknown-direction Exact pin a manager can't downgrade — an AUR VCS version compareVersions cannot order",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makePackageReconciler;
      const calls: string[] = [];
      const props: PackageProps = {
        manager: "yay",
        name: "some-vcs-pkg",
        version: { _tag: "Exact", version: "r1234.deadbeef" },
        updatePolicy: { _tag: "ToSpec" },
      };
      const desired = yield* reconciler.desired(props);
      const observed = Option.some<PackageState>({
        manager: "yay",
        name: "some-vcs-pkg",
        version: "r1235.cafebabe",
      });

      const error = yield* reconciler
        .apply({ props, observed, desired }, applyCtx(capturingExec("", calls)))
        .pipe(Effect.flip);

      expect(error._tag).toBe("CannotDowngrade");
      expect(error).toMatchObject({ direction: "Unknown" });
      expect(calls).toEqual([]);
    }),
);

it.effect(
  "Package reconciler apply: an Unknown-direction Channel switch proceeds rather than being refused — a channel change is not a downgrade question",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makePackageReconciler;
      const calls: string[] = [];
      const props: PackageProps = {
        manager: "flatpak",
        name: "org.gnome.Platform",
        version: { _tag: "Channel", name: "45" },
        updatePolicy: { _tag: "ToSpec" },
      };
      const desired = yield* reconciler.desired(props);
      const observed = Option.some<PackageState>({
        manager: "flatpak",
        name: "org.gnome.Platform",
        version: "stable",
      });

      // flatpak's own `canDowngrade` is `false`, and "stable" vs. "45" is
      // exactly the kind of pair `compareVersions` calls `"Unknown"` (neither
      // is dotted-numeric) — if the guard fired on every `"Unknown"`
      // regardless of spec tag, this legitimate channel switch would be
      // refused. It must not be: `apply` should reach `install`.
      const result = yield* reconciler.apply(
        { props, observed, desired },
        applyCtx(capturingExec("", calls)),
      );

      expect(result).toEqual(desired);
      expect(calls).toEqual(["flatpak install -y --noninteractive org.gnome.Platform//45"]);
    }),
);

it.effect(
  "Package reconciler: a plan-phase observe cannot make a later apply-phase observe skip a real uninstall",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makePackageReconciler;
      const props: PackageProps = { manager: "brew", name: "ripgrep" };

      // Planning sees ripgrep present, and caches that under the plan-phase index.
      const planned = yield* reconciler.observe(props, planCtx(fakeExec("ripgrep\n")));
      expect(planned).toEqual(Option.some({ manager: "brew", name: "ripgrep" }));

      // Something uninstalls ripgrep in the gap between plan and apply. The
      // apply-phase observe (a distinct `ApplyContext`) must re-list rather
      // than reuse the plan-phase cache, or this uninstall would go unnoticed
      // and `apply` would never run.
      const applied = yield* reconciler.observe(props, applyCtx(fakeExec("otherpkg\n")));
      expect(applied).toEqual(Option.none());
    }),
);

it.effect(
  "Package reconciler: apply-phase observe shares one memoized listing per manager, and invalidates it after an install",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makePackageReconciler;
      const calls: string[] = [];
      const exec = capturingExec("ripgrep\n", calls);

      const reconcileOne = (name: string) =>
        Effect.gen(function* () {
          const props: PackageProps = { manager: "brew", name };
          const observed = yield* reconciler.observe(props, applyCtx(exec));
          const desired = yield* reconciler.desired(props);
          if (Option.isSome(observed) && reconciler.matches(observed.value, desired)) {
            return observed.value;
          }
          return yield* reconciler.apply({ props, observed, desired }, applyCtx(exec));
        });

      // "ripgrep" is already in the fake `brew list` output.
      yield* reconcileOne("ripgrep");
      // "fd" isn't — this installs it, and must invalidate the cache.
      yield* reconcileOne("fd");
      // A third package on the same manager: the cache was invalidated by
      // the "fd" install, so this must re-list rather than reuse the first
      // (now-stale) snapshot.
      yield* reconcileOne("eza");

      const listCalls = calls.filter((c) => c.includes("list"));
      const installCalls = calls.filter((c) => c.includes("install"));
      // Two real listings (initial + one re-list after the "fd" install),
      // NOT three — one per resource is exactly the bug this fixes.
      expect(listCalls.length).toBe(2);
      expect(installCalls).toEqual(["brew install fd", "brew install eza"]);
    }),
);

// ---------------------------------------------------------------------------
// Repo.ts's reconciler: same treatment as Package.ts above.
// ---------------------------------------------------------------------------

// `RepoProps.repo` is a `RepoSpec` tagged union (Brew/Apt/Dnf/Flatpak), each
// with its own manager-specific field(s) — a manager and a repo value from a
// different manager can no longer be paired. These are compile-time guards:
// if `RepoSpec` regressed to a flat `{ manager, repo: string }` shape (or a
// `repo` string were accepted where a `RepoSpec` is required), both
// `@ts-expect-error`s below would stop being errors.
// @ts-expect-error -- `dnf` paired with a Flatpak-shaped value: no such `RepoSpec` exists.
const _mismatchedManagerAndField: RepoProps = { repo: { _tag: "Dnf", name: "flathub" } };
// @ts-expect-error -- a bare string `repo` is not a `RepoSpec`.
const _bareStringRepo: RepoProps = { repo: "can1357/tap" };

it.effect("Repo reconciler address is the repo's tag", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRepoReconciler;
    expect(reconciler.address({ repo: { _tag: "Brew", tap: "can1357/tap" } })).toBe("Brew");
    expect(reconciler.address({ repo: { _tag: "Apt", ppa: "ppa:some/ppa" } })).toBe("Apt");
  }),
);

it.effect(
  "Repo reconciler observe: Option.none() when the repo is missing from a live listing",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeRepoReconciler;
      const observed = yield* reconciler.observe(
        { repo: { _tag: "Brew", tap: "can1357/tap" } },
        planCtx(fakeExec("homebrew/cask\n")),
      );
      expect(observed).toEqual(Option.none());
    }),
);

it.effect("Repo reconciler observe: the repo's state once a live listing includes it", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRepoReconciler;
    const observed = yield* reconciler.observe(
      { repo: { _tag: "Brew", tap: "can1357/tap" } },
      planCtx(fakeExec("can1357/tap\n")),
    );
    expect(observed).toEqual(Option.some({ repo: { _tag: "Brew", tap: "can1357/tap" } }));
  }),
);

it.effect("Repo reconciler apply: adds the repo and returns its state", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRepoReconciler;
    const calls: string[] = [];
    const props: RepoProps = { repo: { _tag: "Brew", tap: "can1357/tap" } };
    const desired = yield* reconciler.desired(props);

    const result = yield* reconciler.apply(
      { props, observed: Option.none(), desired },
      applyCtx(capturingExec("", calls)),
    );

    expect(result).toEqual({ repo: { _tag: "Brew", tap: "can1357/tap" } });
    expect(calls).toEqual(["brew tap can1357/tap"]);
  }),
);

it.effect(
  "Repo reconciler drift: empty exactly when matches is true, no direction — no RepoSpec field is ordered",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeRepoReconciler;
      const drift = reconciler.drift;
      if (drift === undefined) return yield* Effect.die("Repo reconciler must define drift");

      const desired: RepoProps = { repo: { _tag: "Brew", tap: "can1357/tap" } };

      const matching: RepoProps = { repo: { _tag: "Brew", tap: "can1357/tap" } };
      expect(reconciler.matches(matching, desired)).toBe(true);
      expect(drift(matching, desired)).toEqual([]);

      const mismatching: RepoProps = { repo: { _tag: "Brew", tap: "other/tap" } };
      expect(reconciler.matches(mismatching, desired)).toBe(false);
      expect(drift(mismatching, desired)).toEqual([
        { field: "tap", observed: "other/tap", desired: "can1357/tap" },
      ]);

      // Flatpak's two-field spec: only the field that actually differs is reported.
      const flatpakDesired: RepoProps = {
        repo: { _tag: "Flatpak", name: "flathub", location: "https://a" },
      };
      const flatpakSameLocation: RepoProps = {
        repo: { _tag: "Flatpak", name: "flathub", location: "https://a" },
      };
      expect(drift(flatpakSameLocation, flatpakDesired)).toEqual([]);
      // A differing `location` is NOT drift for Flatpak, and that is the point:
      // `matches` compares remotes on `name` alone because `remote-add
      // --if-not-exists` cannot repoint an existing name, so a location difference
      // is something `apply` provably cannot fix. `drift` has to agree with
      // `matches` or the plan reports a change it then never makes.
      const flatpakDifferentLocation: RepoProps = {
        repo: { _tag: "Flatpak", name: "flathub", location: "https://b" },
      };
      expect(reconciler.matches(flatpakDifferentLocation, flatpakDesired)).toBe(true);
      expect(drift(flatpakDifferentLocation, flatpakDesired)).toEqual([]);
      // Every field this reconciler tracks names a value, never an order — no
      // case above ever carries a `direction`.
    }),
);

it.effect(
  "Repo reconciler: a plan-phase observe cannot make a later apply-phase observe miss a real removal",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeRepoReconciler;
      const props: RepoProps = { repo: { _tag: "Brew", tap: "can1357/tap" } };

      const planned = yield* reconciler.observe(props, planCtx(fakeExec("can1357/tap\n")));
      expect(planned).toEqual(Option.some({ repo: { _tag: "Brew", tap: "can1357/tap" } }));

      const applied = yield* reconciler.observe(props, applyCtx(fakeExec("homebrew/cask\n")));
      expect(applied).toEqual(Option.none());
    }),
);

it.effect(
  "Repo reconciler observe: dnf, matching a COPR named as owner/project against `dnf copr list`'s hub-qualified output",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeRepoReconciler;
      const observed = yield* reconciler.observe(
        { repo: { _tag: "Dnf", project: "atim/lazygit" } },
        // Real captured `dnf copr list` output — see Dnf.ts's doc comment.
        planCtx(fakeExec("copr.fedorainfracloud.org/atim/lazygit\n")),
      );
      expect(observed).toEqual(Option.some({ repo: { _tag: "Dnf", project: "atim/lazygit" } }));
    }),
);

it.effect(
  "Repo reconciler apply: dnf adds a COPR via `sudo dnf copr enable -y <project>` when the caller's execution context asks for sudo",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeRepoReconciler;
      const calls: string[] = [];
      const props: RepoProps = { repo: { _tag: "Dnf", project: "atim/lazygit" } };
      const desired = yield* reconciler.desired(props);

      const result = yield* reconciler.apply(
        { props, observed: Option.none(), desired },
        applyCtx(capturingExec("", calls), SUDO),
      );

      expect(result).toEqual({ repo: { _tag: "Dnf", project: "atim/lazygit" } });
      expect(calls).toEqual(["sudo dnf copr enable -y atim/lazygit"]);
    }),
);

it.effect(
  "Repo reconciler apply: dnf's addRepo runs unprefixed when no execution context is given at all — privilege none is the default",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeRepoReconciler;
      const calls: string[] = [];
      const props: RepoProps = { repo: { _tag: "Dnf", project: "atim/lazygit" } };
      const desired = yield* reconciler.desired(props);

      yield* reconciler.apply(
        { props, observed: Option.none(), desired },
        applyCtx(capturingExec("", calls)),
      );

      expect(calls).toEqual(["dnf copr enable -y atim/lazygit"]);
    }),
);

it.effect(
  "Repo reconciler observe: flatpak, Option.none() against a real empty `flatpak remotes` listing",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeRepoReconciler;
      const observed = yield* reconciler.observe(
        {
          repo: {
            _tag: "Flatpak",
            name: "flathub",
            location: "https://dl.flathub.org/repo/flathub.flatpakrepo",
          },
        },
        planCtx(fakeExec(fixture("flatpak-remotes-empty.txt"))),
      );
      expect(observed).toEqual(Option.none());
    }),
);

it.effect(
  "Repo reconciler observe: flatpak, matching the bare remote name against a real populated listing",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeRepoReconciler;
      // A recipe naming just the bare remote name — matching whatever this
      // resource is tracking by name — converges against a real listing.
      const observed = yield* reconciler.observe(
        { repo: { _tag: "Flatpak", name: "flathub" } },
        planCtx(fakeExec(fixture("flatpak-remotes.txt"))),
      );
      expect(observed).toEqual(Option.some({ repo: { _tag: "Flatpak", name: "flathub" } }));
    }),
);

it.effect(
  "Repo reconciler observe: flatpak matches a bootstrap-URL repo against a live listing, " +
    "because `apply` provably cannot remediate a URL difference",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeRepoReconciler;
      const observed = yield* reconciler.observe(
        {
          repo: {
            _tag: "Flatpak",
            name: "flathub",
            location: "https://dl.flathub.org/repo/flathub.flatpakrepo",
          },
        },
        planCtx(fakeExec(fixture("flatpak-remotes.txt"))),
      );
      // `flatpak remotes` reports the *resolved* location
      // (https://dl.flathub.org/repo/), never the bootstrap URL passed to
      // `remote-add`. This used to assert `Option.none()` and call it an
      // unavoidable limitation. It is avoidable, and the reason is one step
      // further on: `remote-add --if-not-exists` against an existing name does
      // not repoint it — measured — so comparing on URL reported drift that
      // `apply` can never fix, and the plan never went quiet. Matching on `name`,
      // which is the key `remote-add` itself uses, is what converges.
      expect(Option.isSome(observed)).toBe(true);
    }),
);

it.effect(
  "Repo reconciler apply: flatpak adds a remote via " +
    "`flatpak remote-add --if-not-exists <name> <location>`",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeRepoReconciler;
      const calls: string[] = [];
      const props: RepoProps = {
        repo: {
          _tag: "Flatpak",
          name: "flathub",
          location: "https://dl.flathub.org/repo/flathub.flatpakrepo",
        },
      };
      const desired = yield* reconciler.desired(props);

      const result = yield* reconciler.apply(
        { props, observed: Option.none(), desired },
        applyCtx(capturingExec("", calls)),
      );

      expect(result).toEqual(props);
      expect(calls).toEqual([
        "flatpak remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo",
      ]);
    }),
);

it.effect(
  "Repo reconciler apply: flatpak with no location fails loudly with BackendParseError, " +
    "the typed replacement for the old malformed-repo-string parse failure",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeRepoReconciler;
      const calls: string[] = [];
      const props: RepoProps = { repo: { _tag: "Flatpak", name: "flathub" } };
      const desired = yield* reconciler.desired(props);

      const error = yield* reconciler
        .apply({ props, observed: Option.none(), desired }, applyCtx(capturingExec("", calls)))
        .pipe(Effect.flip);

      expect(error._tag).toBe("BackendParseError");
      expect(calls).toEqual([]);
    }),
);
