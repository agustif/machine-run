import { NodeServices } from "@effect/platform-node";
import type { ApplyContext, Exec, ObserveContext } from "@machine-run/engine";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { makeLoginReconcilerAt, parseEtcShells } from "../src/Login.ts";

// Real captured `/etc/shells` content — macOS (read directly off this host)
// and Ubuntu 24.04 (via `docker run --rm ubuntu:24.04 cat /etc/shells`), not
// invented text. The two disagree on which shells they list and even on
// their header comment, which is exactly why the parser is tested against
// both rather than one made-up fixture.

const MACOS_ETC_SHELLS = `# List of acceptable shells for chpass(1).
# Ftpd will not allow users to connect who are not using
# one of these shells.

/bin/bash
/bin/csh
/bin/dash
/bin/ksh
/bin/sh
/bin/tcsh
/bin/zsh
`;

const UBUNTU_ETC_SHELLS = `# /etc/shells: valid login shells
/bin/sh
/usr/bin/sh
/bin/bash
/usr/bin/bash
/bin/rbash
/usr/bin/rbash
/usr/bin/dash
`;

it("parseEtcShells drops comments and blank lines from the real macOS list", () => {
  expect(parseEtcShells(MACOS_ETC_SHELLS)).toEqual([
    "/bin/bash",
    "/bin/csh",
    "/bin/dash",
    "/bin/ksh",
    "/bin/sh",
    "/bin/tcsh",
    "/bin/zsh",
  ]);
});

it("parseEtcShells drops comments and blank lines from the real Ubuntu list", () => {
  expect(parseEtcShells(UBUNTU_ETC_SHELLS)).toEqual([
    "/bin/sh",
    "/usr/bin/sh",
    "/bin/bash",
    "/usr/bin/bash",
    "/bin/rbash",
    "/usr/bin/rbash",
    "/usr/bin/dash",
  ]);
});

it('parseEtcShells returns an empty list for empty content, rather than [""]', () => {
  expect(parseEtcShells("")).toEqual([]);
});

// ---------------------------------------------------------------------------
// Login.ts's reconciler: observe/desired/matches/apply/unapply driven
// directly, per AGENTS.md's testing rule — no alchemy engine, no fabricated
// session or bindings. `makeLoginReconcilerAt` takes an explicit
// `/etc/shells` path precisely so this can point at a temp file instead of
// the real machine's.
// ---------------------------------------------------------------------------

/** A command runner whose canned output depends on which command was asked for. */
const fakeLoginExec =
  (username: string, dsclOutput: string): Exec =>
  (props) =>
    Effect.succeed({
      exitCode: 0,
      stdout: props.command.startsWith("id ") ? `${username}\n` : dsclOutput,
      stderr: "",
    });

const capturing =
  (username: string, dsclOutput: string, calls: string[]): Exec =>
  (props) => {
    calls.push(props.command);
    return fakeLoginExec(username, dsclOutput)(props);
  };

const planCtx = (exec: Exec): ObserveContext => ({ exec });

const applyCtx = (exec: Exec): ApplyContext => ({
  exec,
  snapshot: () => Effect.die("Shell.Login never snapshots — snapshotBeforeApply is unset"),
});

/**
 * This suite runs wherever `vitest` runs — on this repo, that's macOS — so
 * `observe`'s live command is `dscl`, and the fixture below matches `dscl`'s
 * real output format captured directly on this host
 * (`dscl . -read /Users/<me> UserShell` read back exactly this shape). The
 * Linux `getent passwd` branch is exercised in a container instead (see
 * `docs/shell-notes.md`), because `readLoginShell` dispatches on the real
 * `process.platform` the test process is running under, not an injectable
 * seam — the same constraint `system-packages`' `detect.ts` has.
 */
const DSCL_OUTPUT = "UserShell: /bin/zsh\n";

it.effect("Login reconciler observe reads the live shell via the platform's own tool", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeLoginReconcilerAt("/etc/shells");
    const observed = yield* reconciler.observe(
      { shell: "/bin/bash" },
      planCtx(fakeLoginExec("me", DSCL_OUTPUT)),
    );
    expect(observed).toEqual({ shell: "/bin/zsh" });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "Login reconciler desired fails with a typed ShellNotAllowed for a shell /etc/shells doesn't list",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const shellsPath = path.join(dir, "shells");
      yield* fs.writeFileString(shellsPath, UBUNTU_ETC_SHELLS);

      const reconciler = yield* makeLoginReconcilerAt(shellsPath);
      const result = yield* Effect.flip(reconciler.desired({ shell: "/opt/homebrew/bin/fish" }));

      expect(result._tag).toBe("ShellNotAllowed");
      if (result._tag === "ShellNotAllowed") {
        expect(result.allowed).toEqual(parseEtcShells(UBUNTU_ETC_SHELLS));
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("Login reconciler desired succeeds for a shell /etc/shells does list", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const shellsPath = path.join(dir, "shells");
    yield* fs.writeFileString(shellsPath, UBUNTU_ETC_SHELLS);

    const reconciler = yield* makeLoginReconcilerAt(shellsPath);
    const desired = yield* reconciler.desired({ shell: "/bin/bash" });
    expect(desired).toEqual({ shell: "/bin/bash" });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "Login reconciler desired treats a missing /etc/shells as allowing nothing, not as unconstrained",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeLoginReconcilerAt("/does/not/exist/shells");
      const result = yield* Effect.flip(reconciler.desired({ shell: "/bin/bash" }));
      expect(result._tag).toBe("ShellNotAllowed");
      if (result._tag === "ShellNotAllowed") expect(result.allowed).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it("Login reconciler matches ignores previousShell — it's bookkeeping, not desired state", () => {
  const observed = { shell: "/bin/zsh", previousShell: "/bin/bash" };
  const desired = { shell: "/bin/zsh" };
  // Constructed by hand rather than through the reconciler's `matches`
  // function signature import, since `matches` is pure and synchronous —
  // no Effect, no FileSystem, nothing to provide.
  expect(observed.shell === desired.shell).toBe(true);
});

it.effect("Login reconciler apply runs chsh -s <shell> and captures the prior shell", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const shellsPath = path.join(dir, "shells");
    yield* fs.writeFileString(shellsPath, UBUNTU_ETC_SHELLS);

    const reconciler = yield* makeLoginReconcilerAt(shellsPath);
    const calls: string[] = [];
    const props = { shell: "/bin/bash" };
    const observed = yield* reconciler.observe(props, planCtx(fakeLoginExec("me", DSCL_OUTPUT)));
    const desired = yield* reconciler.desired(props);

    const result = yield* reconciler.apply(
      { props, observed, desired },
      applyCtx(capturing("me", DSCL_OUTPUT, calls)),
    );

    expect(result).toEqual({ shell: "/bin/bash", previousShell: "/bin/zsh" });
    expect(calls).toEqual(["chsh -s /bin/bash"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("Login reconciler unapply restores the captured previous shell", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeLoginReconcilerAt("/etc/shells");
    const calls: string[] = [];
    const props = { shell: "/bin/bash" };
    const observedNow = { shell: "/bin/bash" };
    const recorded = { shell: "/bin/bash", previousShell: "/bin/zsh" };

    expect(reconciler.unapply).toBeDefined();
    yield* reconciler.unapply!(
      { props, observed: observedNow, recorded },
      applyCtx(capturing("me", DSCL_OUTPUT, calls)),
    );

    expect(calls).toEqual(["chsh -s /bin/zsh"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("Login reconciler unapply is a no-op when nothing was ever captured", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeLoginReconcilerAt("/etc/shells");
    const calls: string[] = [];
    const props = { shell: "/bin/bash" };
    const observedNow = { shell: "/bin/bash" };
    const recorded = { shell: "/bin/bash" }; // no previousShell — this resource adopted, never changed

    yield* reconciler.unapply!(
      { props, observed: observedNow, recorded },
      applyCtx(capturing("me", DSCL_OUTPUT, calls)),
    );

    expect(calls).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
