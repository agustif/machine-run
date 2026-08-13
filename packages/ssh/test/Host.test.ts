import { expandHome, MachinePaths, MachinePathsLive } from "@machine-run/core";
import * as Dotfiles from "@machine-run/dotfiles";
import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { sshHostBlockProps, type SshHostProps } from "../src/Host.ts";

const baseProps: SshHostProps = {
  configPath: "~/.ssh/config",
  name: "exe",
  hostnames: ["exe.dev"],
};

// ---------------------------------------------------------------------------
// Pure rendering: option ordering, `~` pass-through, mode/position, `after`.
// ---------------------------------------------------------------------------

it("renders only the Host line when no optional fields are set", () => {
  const rendered = sshHostBlockProps(baseProps);
  expect(rendered.content).toBe("Host exe.dev");
});

it("joins multiple hostnames on the Host line, space-separated", () => {
  const rendered = sshHostBlockProps({ ...baseProps, hostnames: ["exe.dev", "*.exe.xyz"] });
  expect(rendered.content).toBe("Host exe.dev *.exe.xyz");
});

it("renders User, IdentityFile and ProxyCommand in that fixed order, regardless of which are set", () => {
  const rendered = sshHostBlockProps({
    ...baseProps,
    proxyCommand: "nc -x proxy:1080 %h %p",
    identityFile: "~/.ssh/id_ed25519_exe",
    user: "deploy",
  });
  expect(rendered.content).toBe(
    [
      "Host exe.dev",
      "\tUser deploy",
      "\tIdentityFile ~/.ssh/id_ed25519_exe",
      "\tProxyCommand nc -x proxy:1080 %h %p",
    ].join("\n"),
  );
});

it("appends `extra` entries after the fixed fields, in the order they were given", () => {
  const rendered = sshHostBlockProps({
    ...baseProps,
    user: "deploy",
    extra: { ForwardAgent: "yes", IdentitiesOnly: "yes" },
  });
  expect(rendered.content).toBe(
    ["Host exe.dev", "\tUser deploy", "\tForwardAgent yes", "\tIdentitiesOnly yes"].join("\n"),
  );
});

it("passes `configPath` through unchanged — `~` and all — never expanding it itself", () => {
  const rendered = sshHostBlockProps({ ...baseProps, configPath: "~/.ssh/config" });
  expect(rendered.path).toBe("~/.ssh/config");
});

it("always requests prepend and 0o700, and derives the marker from `name`", () => {
  const rendered = sshHostBlockProps(baseProps);
  expect(rendered.position).toBe("prepend");
  expect(rendered.directoryMode).toBe(0o700);
  expect(rendered.marker).toBe("ssh-host:exe");
});

it("omits `after` entirely when not given, rather than sending an explicit `undefined`", () => {
  const rendered = sshHostBlockProps(baseProps);
  expect("after" in rendered).toBe(false);
});

it("carries `after` through verbatim when given", () => {
  const rendered = sshHostBlockProps({ ...baseProps, after: "some-other-block-hash" });
  expect(rendered.after).toBe("some-other-block-hash");
});

// ---------------------------------------------------------------------------
// End to end through the real `Dotfiles.ManagedBlock` reconciler: the
// invariant worth pinning is that a new block lands ahead of a hand-written
// catch-all, because ssh_config is first-match-wins and a block appended
// after `Host *` would silently never be read for any key the catch-all
// also sets.
// ---------------------------------------------------------------------------

const layer = Layer.mergeAll(MachinePathsLive(), NodeCrypto.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const observeCtx = { exec: () => Effect.die("Dotfiles.ManagedBlock never runs a command") };
const applyCtx = { ...observeCtx, snapshot: () => Effect.succeed(undefined) };

it.effect(
  "prepend lands the new block ahead of a pre-existing hand-written `Host *` catch-all",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reconciler = yield* Dotfiles.makeManagedBlockReconciler;
      const dir = yield* fs.makeTempDirectoryScoped();
      const configPath = path.join(dir, "config");

      // The situation `sshHost`'s doc comment describes: a config file that
      // predates machine-run, already carrying a broad `Host *` stanza near
      // the top.
      const handWritten = "Host *\n\tForwardAgent yes\n\tIdentitiesOnly yes\n";
      yield* fs.writeFileString(configPath, handWritten);

      const rendered = sshHostBlockProps({
        configPath,
        name: "exe",
        hostnames: ["exe.dev"],
        user: "deploy",
      });

      const desired = yield* reconciler.desired(rendered);
      yield* reconciler.apply({ props: rendered, observed: undefined, desired }, applyCtx);

      const written = yield* fs.readFileString(configPath);

      // The invariant: the managed block's own `Host` line appears before
      // the hand-written `Host *` line — not merely "is present somewhere" —
      // because ssh only ever honours the FIRST matching `Host` block for a
      // given key. If this ever appended instead of prepending, both lines
      // would still be present but in the wrong order, and this assertion
      // (not a mere `toContain`) is what catches that.
      const managedIndex = written.indexOf("Host exe.dev");
      const catchAllIndex = written.indexOf("Host *");
      expect(managedIndex).toBeGreaterThanOrEqual(0);
      expect(catchAllIndex).toBeGreaterThan(managedIndex);

      // The hand-written content survives untouched alongside the new block.
      expect(written).toContain("ForwardAgent yes");
      expect(written).toContain("\tUser deploy");
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("creates ~/.ssh (here, the config's parent directory) at exactly 0o700", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* Dotfiles.makeManagedBlockReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    // Nested and not yet created, so `ManagedBlock`'s `makeDirectory` is what
    // creates it — proving the mode came from `directoryMode`, not from
    // whatever `makeTempDirectoryScoped` happened to use.
    const configPath = path.join(dir, ".ssh", "config");

    const rendered = sshHostBlockProps({ configPath, name: "exe", hostnames: ["exe.dev"] });
    const desired = yield* reconciler.desired(rendered);
    yield* reconciler.apply({ props: rendered, observed: undefined, desired }, applyCtx);

    const info = yield* fs.stat(path.dirname(configPath));
    expect(Number(info.mode) & 0o777).toBe(0o700);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

/**
 * A `MachinePaths` pinned to a fake home rather than the real
 * `MachinePathsLive()` (which reads `os.homedir()`), so this test can prove
 * `~/.ssh/config` really does resolve under *some* home directory without
 * mutating this process's real `$HOME` — `expandHome` is the same pure
 * function `MachinePathsLive` itself is built on (see `core/src/Paths.ts`),
 * just wired to a temp directory instead of the real one.
 */
const fakeHomeLayer = (home: string) =>
  Layer.effect(
    MachinePaths,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      return { home, expand: (target: string) => expandHome(path, target, home) };
    }),
  );

it.effect(
  "resolves a leading `~` through the real pipeline (MachinePaths), not just in this test's own absolute paths",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // The fake home has to exist before it can be baked into a layer, so
      // it's created here, with only `NodeServices` in scope, before
      // `fakeHomeLayer` is ever built.
      const dir = yield* fs.makeTempDirectoryScoped();

      const rendered = sshHostBlockProps({
        configPath: "~/.ssh/config",
        name: "exe",
        hostnames: ["exe.dev"],
      });

      const runApply = Effect.gen(function* () {
        const reconciler = yield* Dotfiles.makeManagedBlockReconciler;
        const desired = yield* reconciler.desired(rendered);
        yield* reconciler.apply({ props: rendered, observed: undefined, desired }, applyCtx);
      }).pipe(Effect.provide(Layer.mergeAll(fakeHomeLayer(dir), NodeCrypto.layer)));

      yield* runApply;

      const expanded = path.join(dir, ".ssh", "config");
      expect(yield* fs.exists(expanded)).toBe(true);
      expect(yield* fs.readFileString(expanded)).toContain("Host exe.dev");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
