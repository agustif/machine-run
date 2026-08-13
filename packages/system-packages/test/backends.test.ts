import type { ApplyContext, Exec, ObserveContext } from "@machine-run/engine";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeYayBackend, makeParuBackend } from "../src/backends/linux/Aur.ts";
import { makeAptBackend } from "../src/backends/linux/Apt.ts";
import { makeFlatpakBackend } from "../src/backends/linux/Flatpak.ts";
import { makeSnapBackend } from "../src/backends/linux/Snap.ts";
import { makeBrewBackend, makeBrewCaskBackend } from "../src/backends/macos/Brew.ts";
import { makeGoBackend, parseGoVersionM } from "../src/backends/language/Go.ts";
import { makeCargoBackend } from "../src/backends/language/Cargo.ts";
import { makeGemBackend } from "../src/backends/language/Gem.ts";
import { makeChocoBackend } from "../src/backends/windows/Choco.ts";
import { makeDnfBackend } from "../src/backends/linux/Dnf.ts";
import { makeMasBackend } from "../src/backends/macos/Mas.ts";
import { makePortBackend } from "../src/backends/macos/MacPorts.ts";
import { makeNpmBackend } from "../src/backends/language/Npm.ts";
import { makePacmanBackend } from "../src/backends/linux/Pacman.ts";
import { makePipxBackend, parsePipxList } from "../src/backends/language/Pipx.ts";
import { makeUvToolBackend, parseUvToolList } from "../src/backends/language/UvTool.ts";
import { parseWingetList } from "../src/backends/windows/Winget.ts";
import { makePackageReconciler } from "../src/Package.ts";
import { toId } from "../src/bulk.ts";
import { firstTokens, lines } from "../src/parse.ts";
import { makeRepoReconciler } from "../src/Repo.ts";

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

/** An `ObserveContext` — the shape `diff`/`read` pass while planning. */
const planCtx = (exec: Exec): ObserveContext => ({ exec });

/**
 * An `ApplyContext` — the shape `reconcile` passes both to its pre-apply
 * re-observe and to `apply` itself. `snapshot` is never called by
 * `Package`/`Repo` (neither sets `snapshotBeforeApply`), so a stub that dies
 * if invoked keeps that invariant honest.
 */
const applyCtx = (exec: Exec): ApplyContext => ({
  exec,
  snapshot: () => Effect.die("Package/Repo never snapshot — snapshotBeforeApply is unset"),
});

it.effect("brew backend parses `brew list --formula` output into names", () =>
  Effect.gen(function* () {
    const backend = makeBrewBackend();
    const installed = yield* backend.list(fakeExec("mise\nripgrep\nfd\n"));
    expect(installed).toEqual(["mise", "ripgrep", "fd"]);
  }),
);

it.effect("brew backend install shells out to `brew install <name>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeBrewBackend();
    yield* backend.install("ripgrep", capturingExec("", calls));
    expect(calls).toEqual(["brew install ripgrep"]);
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
    expect(installed).toEqual(["ada-url", "koekeishiya/formulae/skhd"]);
    expect(calls).toEqual(["brew list --formula --full-name"]);
  }),
);

it.effect("brew-cask backend uses `brew install --cask`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeBrewCaskBackend();
    yield* backend.install("orbstack", capturingExec("", calls));
    expect(calls).toEqual(["brew install --cask orbstack"]);
  }),
);

it.effect("apt backend parses dpkg-query output into package names", () =>
  Effect.gen(function* () {
    const backend = makeAptBackend();
    const installed = yield* backend.list(fakeExec("curl\ngit\n"));
    expect(installed).toEqual(["curl", "git"]);
  }),
);

it.effect("port backend parses `port installed` output into names", () =>
  Effect.gen(function* () {
    const backend = makePortBackend();
    const installed = yield* backend.list(
      fakeExec(
        "The following ports are currently installed:\n  git @2.43.0_0 (active)\n  wget @1.24.5_0 (active)\n",
      ),
    );
    expect(installed).toEqual(["git", "wget"]);
  }),
);

it.effect("cargo backend ignores indented binary lines from --list", () =>
  Effect.gen(function* () {
    const backend = makeCargoBackend();
    const installed = yield* backend.list(
      fakeExec("cargo-bloat v0.11.1:\n    cargo-bloat\nripgrep v14.0.0:\n    rg\n"),
    );
    expect(installed).toEqual(["cargo-bloat", "ripgrep"]);
  }),
);

it.effect("npm backend parses `npm ls -g --json` dependencies", () =>
  Effect.gen(function* () {
    const backend = makeNpmBackend();
    const installed = yield* backend.list(
      fakeExec(JSON.stringify({ dependencies: { typescript: {}, pnpm: {} } })),
    );
    expect(installed.sort()).toEqual(["pnpm", "typescript"]);
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
      const realElsproblemsOutput = JSON.stringify({
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
      expect(installed.sort()).toEqual(["has-peer-dep", "real-pkg"]);
    }),
);

it.effect("npm backend install shells out to `npm install -g <name>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeNpmBackend();
    yield* backend.install("typescript", capturingExec("", calls));
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
    expect(installed).toContain("tree");
    expect(installed).toContain("dnf5");
    expect(installed.length).toBe(22);
  }),
);

it.effect("dnf backend install shells out to `sudo dnf install -y <name>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeDnfBackend();
    yield* backend.install("tree", capturingExec("", calls));
    expect(calls).toEqual(["sudo dnf install -y tree"]);
  }),
);

it.effect(
  "dnf backend listRepos parses `dnf copr list`, reporting both hub-qualified and bare forms",
  () =>
    Effect.gen(function* () {
      const backend = makeDnfBackend();
      const listRepos = backend.listRepos;
      if (!listRepos) throw new Error("dnf backend must implement listRepos");
      // Real captured output from the same container after
      // `dnf copr enable -y atim/lazygit`.
      const repos = yield* listRepos(fakeExec("copr.fedorainfracloud.org/atim/lazygit\n"));
      expect(repos).toEqual(["copr.fedorainfracloud.org/atim/lazygit", "atim/lazygit"]);
    }),
);

it.effect("dnf backend addRepo shells out to `sudo dnf copr enable -y <repo>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeDnfBackend();
    const addRepo = backend.addRepo;
    if (!addRepo) throw new Error("dnf backend must implement addRepo");
    yield* addRepo("atim/lazygit", capturingExec("", calls));
    expect(calls).toEqual(["sudo dnf copr enable -y atim/lazygit"]);
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
    expect(installed).toContain("base");
    expect(installed).toContain("bash");
    expect(installed.length).toBe(28);
  }),
);

it.effect("pacman backend install shells out to `sudo pacman -S --noconfirm <name>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makePacmanBackend();
    yield* backend.install("tree", capturingExec("", calls));
    expect(calls).toEqual(["sudo pacman -S --noconfirm tree"]);
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
        capturingExec("yay-bin\nyay-bin-debug\n", yayCalls),
      );
      const installedParu = yield* makeParuBackend().list(
        capturingExec("yay-bin\nyay-bin-debug\n", paruCalls),
      );
      expect(installedYay).toEqual(["yay-bin", "yay-bin-debug"]);
      expect(installedParu).toEqual(["yay-bin", "yay-bin-debug"]);
      expect(yayCalls).toEqual(["pacman -Qmq"]);
      expect(paruCalls).toEqual(["pacman -Qmq"]);
    }),
);

it.effect("yay backend install shells out to `yay -S --noconfirm <name>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    yield* makeYayBackend().install("downgrade", capturingExec("", calls));
    expect(calls).toEqual(["yay -S --noconfirm downgrade"]);
  }),
);

it.effect("paru backend install shells out to `paru -S --noconfirm <name>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    yield* makeParuBackend().install("downgrade", capturingExec("", calls));
    expect(calls).toEqual(["paru -S --noconfirm downgrade"]);
  }),
);

// ---------------------------------------------------------------------------
// New backends verified locally on this machine: pipx, uv tool, gem,
// go install, mas.
// ---------------------------------------------------------------------------

it("parsePipxList extracts the name from real `pipx list --short` output, ignoring the empty-state banner", () => {
  // Real captured output (pipx 1.16.6, installed via `brew install pipx`):
  // populated after `pipx install cowsay`, and the friendly banner pipx
  // prints instead of empty output on a fresh install.
  expect(parsePipxList("cowsay 6.1\n")).toEqual(["cowsay"]);
  expect(parsePipxList("nothing has been installed with pipx 😴\n")).toEqual([]);
});

it.effect("pipx backend install shells out to `pipx install <name>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    yield* makePipxBackend().install("cowsay", capturingExec("", calls));
    expect(calls).toEqual(["pipx install cowsay"]);
  }),
);

it("parseUvToolList extracts the name from real `uv tool list` output, ignoring the empty-state message", () => {
  // Real captured output (uv 0.12.2, already installed on this machine):
  // populated after `uv tool install cowsay`, byte-verified with `sed -n
  // 'l'` to confirm the executable sub-line has no leading indentation
  // (unlike Cargo's), and the empty-state message.
  expect(parseUvToolList("cowsay v6.1\n- cowsay\n")).toEqual(["cowsay"]);
  expect(parseUvToolList("No tools installed\n")).toEqual([]);
});

it.effect("uv-tool backend install shells out to `uv tool install <name>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    yield* makeUvToolBackend().install("cowsay", capturingExec("", calls));
    expect(calls).toEqual(["uv tool install cowsay"]);
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
      expect(installed).toEqual(["bigdecimal", "rake"]);
    }),
);

it.effect("gem backend install shells out to `gem install --user-install <name>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeGemBackend();
    yield* backend.install("rake", capturingExec("", calls));
    expect(calls).toEqual(["gem install --user-install rake"]);
  }),
);

it("parseGoVersionM extracts import paths from real `go version -m <bin>/*` output", () => {
  // Real captured output (macOS, go 1.26.5) after
  // `go install golang.org/x/tools/cmd/goimports@latest` and
  // `...cmd/stringer@latest` — one header + build-info block per binary,
  // only the `path` line is read.
  const realOutput = [
    "/Users/a/go/bin/goimports: go1.26.5",
    "\tpath\tgolang.org/x/tools/cmd/goimports",
    "/Users/a/go/bin/stringer: go1.26.5",
    "\tpath\tgolang.org/x/tools/cmd/stringer",
    "",
  ].join("\n");
  expect(parseGoVersionM(realOutput)).toEqual([
    "golang.org/x/tools/cmd/goimports",
    "golang.org/x/tools/cmd/stringer",
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
    yield* backend.install("golang.org/x/tools/cmd/goimports", capturingExec("", calls));
    expect(calls).toEqual(["go install golang.org/x/tools/cmd/goimports@latest"]);
  }),
);

it.effect("mas backend parses real `mas list` output, taking the numeric App Store id", () =>
  Effect.gen(function* () {
    // Real captured output from this machine's own (signed-in) `mas list` —
    // the id column's width varies (leading-space-padded), so this is also
    // a real exercise of `firstTokens` after `lines()`'s trim, not a
    // fixed-width parse.
    const backend = makeMasBackend();
    const installed = yield* backend.list(
      fakeExec(
        [
          " 937984704  Amphetamine  (5.3.2)",
          " 640199958  Developer    (11.0.2)",
          "6757482822  VVTerm       (2.14)",
          "",
        ].join("\n"),
      ),
    );
    expect(installed).toEqual(["937984704", "640199958", "6757482822"]);
  }),
);

it.effect("mas backend install shells out to `sudo mas install <id>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeMasBackend();
    yield* backend.install("937984704", capturingExec("", calls));
    expect(calls).toEqual(["sudo mas install 937984704"]);
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
    yield* backend.install("org.gnome.Calculator", capturingExec("", calls));
    expect(calls).toEqual(["flatpak install -y --noninteractive org.gnome.Calculator"]);
  }),
);

it.effect("snap backend list drops the header row and returns [] on an empty listing", () =>
  Effect.gen(function* () {
    // UNVERIFIED beyond the empty case — see Snap.ts's doc comment. Only
    // the trivial empty-stdout path is exercised here, not a populated
    // listing's shape, since no real populated output was captured.
    const backend = makeSnapBackend();
    const installed = yield* backend.list(fakeExec(""));
    expect(installed).toEqual([]);
  }),
);

it.effect("snap backend install shells out to `sudo snap install <name>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const backend = makeSnapBackend();
    yield* backend.install("hello-world", capturingExec("", calls));
    expect(calls).toEqual(["sudo snap install hello-world"]);
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
  const table = [
    "Name              Id               Version   Available Source",
    "---------------------------------------------------------------",
    "Git               Git.Git          2.43.0              winget",
    // A multi-word Name still parses correctly as long as every column
    // boundary is a run of 2+ spaces, as winget's fixed-width table
    // alignment guarantees — the single space inside "Visual Studio Code"
    // is part of the Name itself, not a column boundary.
    "Visual Studio Code  Microsoft.VSCode  1.85.0              winget",
  ].join("\n");
  expect(parseWingetList(table)).toEqual(["Git.Git", "Microsoft.VSCode"]);
});

it("parseWingetList returns [] when no separator row is found", () => {
  expect(parseWingetList("No installed package found matching input criteria.")).toEqual([]);
});

it.effect("choco backend parses `name|version` limit-output lines into names", () =>
  Effect.gen(function* () {
    const backend = makeChocoBackend();
    const installed = yield* backend.list(fakeExec("git|2.43.0\nnodejs-lts|20.11.0\n"));
    expect(installed).toEqual(["git", "nodejs-lts"]);
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
  "Package reconciler observe: undefined when the package is missing from a live listing",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makePackageReconciler;
      const observed = yield* reconciler.observe(
        { manager: "brew", name: "fd" },
        planCtx(fakeExec("ripgrep\n")),
      );
      expect(observed).toBeUndefined();
    }),
);

it.effect("Package reconciler observe: the package's state once a live listing includes it", () =>
  Effect.gen(function* () {
    const reconciler = yield* makePackageReconciler;
    const observed = yield* reconciler.observe(
      { manager: "brew", name: "ripgrep" },
      planCtx(fakeExec("ripgrep\nfd\n")),
    );
    expect(observed).toEqual({ manager: "brew", name: "ripgrep" });
  }),
);

it.effect("Package reconciler matches: true iff manager and name are both equal", () =>
  Effect.gen(function* () {
    const reconciler = yield* makePackageReconciler;
    const desired = { manager: "brew" as const, name: "ripgrep" };
    expect(reconciler.matches({ manager: "brew", name: "ripgrep" }, desired)).toBe(true);
    expect(reconciler.matches({ manager: "brew", name: "fd" }, desired)).toBe(false);
    expect(reconciler.matches({ manager: "cargo", name: "ripgrep" }, desired)).toBe(false);
  }),
);

it.effect("Package reconciler apply: installs the package and returns its state", () =>
  Effect.gen(function* () {
    const reconciler = yield* makePackageReconciler;
    const calls: string[] = [];
    const props = { manager: "brew" as const, name: "fd" };
    const desired = yield* reconciler.desired(props);

    const result = yield* reconciler.apply(
      { props, observed: undefined, desired },
      applyCtx(capturingExec("", calls)),
    );

    expect(result).toEqual({ manager: "brew", name: "fd" });
    expect(calls).toEqual(["brew install fd"]);
  }),
);

it.effect(
  "Package reconciler: a plan-phase observe cannot make a later apply-phase observe skip a real uninstall",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makePackageReconciler;
      const props = { manager: "brew" as const, name: "ripgrep" };

      // Planning sees ripgrep present, and caches that under the plan-phase index.
      const planned = yield* reconciler.observe(props, planCtx(fakeExec("ripgrep\n")));
      expect(planned).toEqual({ manager: "brew", name: "ripgrep" });

      // Something uninstalls ripgrep in the gap between plan and apply. The
      // apply-phase observe (a distinct `ApplyContext`) must re-list rather
      // than reuse the plan-phase cache, or this uninstall would go unnoticed
      // and `apply` would never run.
      const applied = yield* reconciler.observe(props, applyCtx(fakeExec("otherpkg\n")));
      expect(applied).toBeUndefined();
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
          const props = { manager: "brew" as const, name };
          const observed = yield* reconciler.observe(props, applyCtx(exec));
          const desired = yield* reconciler.desired(props);
          if (observed !== undefined && reconciler.matches(observed, desired)) return observed;
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

it.effect("Repo reconciler address is the manager id", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRepoReconciler;
    expect(reconciler.address({ manager: "brew", repo: "can1357/tap" })).toBe("brew");
    expect(reconciler.address({ manager: "apt", repo: "ppa:some/ppa" })).toBe("apt");
  }),
);

it.effect("Repo reconciler observe: undefined when the repo is missing from a live listing", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRepoReconciler;
    const observed = yield* reconciler.observe(
      { manager: "brew", repo: "can1357/tap" },
      planCtx(fakeExec("homebrew/cask\n")),
    );
    expect(observed).toBeUndefined();
  }),
);

it.effect("Repo reconciler observe: the repo's state once a live listing includes it", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRepoReconciler;
    const observed = yield* reconciler.observe(
      { manager: "brew", repo: "can1357/tap" },
      planCtx(fakeExec("can1357/tap\n")),
    );
    expect(observed).toEqual({ manager: "brew", repo: "can1357/tap" });
  }),
);

it.effect("Repo reconciler apply: adds the repo and returns its state", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRepoReconciler;
    const calls: string[] = [];
    const props = { manager: "brew" as const, repo: "can1357/tap" };
    const desired = yield* reconciler.desired(props);

    const result = yield* reconciler.apply(
      { props, observed: undefined, desired },
      applyCtx(capturingExec("", calls)),
    );

    expect(result).toEqual({ manager: "brew", repo: "can1357/tap" });
    expect(calls).toEqual(["brew tap can1357/tap"]);
  }),
);

it.effect(
  "Repo reconciler: a plan-phase observe cannot make a later apply-phase observe miss a real removal",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeRepoReconciler;
      const props = { manager: "brew" as const, repo: "can1357/tap" };

      const planned = yield* reconciler.observe(props, planCtx(fakeExec("can1357/tap\n")));
      expect(planned).toEqual({ manager: "brew", repo: "can1357/tap" });

      const applied = yield* reconciler.observe(props, applyCtx(fakeExec("homebrew/cask\n")));
      expect(applied).toBeUndefined();
    }),
);

it.effect(
  "Repo reconciler observe: dnf, matching a COPR named as owner/project against `dnf copr list`'s hub-qualified output",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeRepoReconciler;
      const observed = yield* reconciler.observe(
        { manager: "dnf", repo: "atim/lazygit" },
        // Real captured `dnf copr list` output — see Dnf.ts's doc comment.
        planCtx(fakeExec("copr.fedorainfracloud.org/atim/lazygit\n")),
      );
      expect(observed).toEqual({ manager: "dnf", repo: "atim/lazygit" });
    }),
);

it.effect("Repo reconciler apply: dnf adds a COPR via `sudo dnf copr enable -y <repo>`", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeRepoReconciler;
    const calls: string[] = [];
    const props = { manager: "dnf" as const, repo: "atim/lazygit" };
    const desired = yield* reconciler.desired(props);

    const result = yield* reconciler.apply(
      { props, observed: undefined, desired },
      applyCtx(capturingExec("", calls)),
    );

    expect(result).toEqual({ manager: "dnf", repo: "atim/lazygit" });
    expect(calls).toEqual(["sudo dnf copr enable -y atim/lazygit"]);
  }),
);
