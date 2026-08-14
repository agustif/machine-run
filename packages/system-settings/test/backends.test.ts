import { CommandError, UnexpectedExit } from "alchemy/Command";
import type { Exec } from "@machine-run/engine";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { GsettingsRelocatableIdentity } from "../src/Backend.ts";
import { DconfBackend } from "../src/backends/Dconf.ts";
import { GsettingsBackend } from "../src/backends/Gsettings.ts";

/**
 * A command runner returning fixed output — real output captured from an
 * `ubuntu:24.04` container running `dconf-cli`/`libglib2.0-bin`/
 * `gsettings-desktop-schemas` (see `docs/settings-notes.md` for the exact
 * commands). No invented fixtures: every string below is verbatim from that
 * container.
 */
const fakeExec =
  (stdout: string): Exec =>
  () =>
    Effect.succeed({ exitCode: 0, stdout, stderr: "" });

/** A command that fails the way a real non-zero exit does, via `Effect.fail`. */
const failingExec =
  (stderr: string): Exec =>
  (props) =>
    Effect.fail(
      new CommandError({
        command: props.command,
        reason: new UnexpectedExit({ exitCode: 1, stderr }),
      }),
    );

/** The same, but recording the command strings it was asked to run. */
const capturingExec =
  (stdout: string, calls: string[]): Exec =>
  (props) => {
    calls.push(props.command);
    return Effect.succeed({ exitCode: 0, stdout, stderr: "" });
  };

// ---------------------------------------------------------------------------
// Gsettings.ts — ordinary (non-relocatable) schema
// ---------------------------------------------------------------------------

it.effect("gsettings backend reads a key's live value verbatim, GVariant quoting included", () =>
  Effect.gen(function* () {
    // `gsettings get org.gnome.desktop.interface clock-format` against a
    // container with `gsettings-desktop-schemas` installed.
    const value = yield* GsettingsBackend.read(
      { _tag: "Gsettings", schema: "org.gnome.desktop.interface", key: "clock-format" },
      fakeExec("'24h'\n"),
    );
    expect(value).toBe("'24h'");
  }),
);

it.effect("gsettings backend treats a non-existent key as absent, not a failure", () =>
  Effect.gen(function* () {
    // `gsettings get org.gnome.desktop.interface not-a-real-key` really
    // exits 1 with "No such key ?not-a-real-key?" on stderr.
    const value = yield* GsettingsBackend.read(
      { _tag: "Gsettings", schema: "org.gnome.desktop.interface", key: "not-a-real-key" },
      failingExec("No such key ?not-a-real-key?\n"),
    );
    expect(value).toBeUndefined();
  }),
);

it.effect("gsettings backend treats a non-existent schema as absent, not a failure", () =>
  Effect.gen(function* () {
    // `gsettings get org.gnome.does.not.exist somekey` really exits 1 with
    // "No such schema ?org.gnome.does.not.exist?" on stderr.
    const value = yield* GsettingsBackend.read(
      { _tag: "Gsettings", schema: "org.gnome.does.not.exist", key: "somekey" },
      failingExec("No such schema ?org.gnome.does.not.exist?\n"),
    );
    expect(value).toBeUndefined();
  }),
);

it.effect("gsettings backend write shells out to `gsettings set <schema> <key> <value>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    yield* GsettingsBackend.write(
      { _tag: "Gsettings", schema: "org.gnome.desktop.interface", key: "clock-format" },
      "'24h'",
      capturingExec("", calls),
    );
    expect(calls).toEqual([
      "gsettings set org.gnome.desktop.interface clock-format ''\\''24h'\\'''",
    ]);
  }),
);

it.effect("gsettings backend rejects a malformed schema before running anything", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const result = yield* Effect.flip(
      GsettingsBackend.read(
        { _tag: "Gsettings", schema: "not-a-valid-schema", key: "clock-format" },
        capturingExec("", calls),
      ),
    );
    expect(result._tag).toBe("SettingKeyInvalid");
    expect(result).toMatchObject({ backend: "gsettings", field: "schema" });
    // Rejected before any command ran.
    expect(calls).toEqual([]);
  }),
);

it.effect("gsettings backend rejects a malformed key name before running anything", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const result = yield* Effect.flip(
      GsettingsBackend.read(
        { _tag: "Gsettings", schema: "org.gnome.desktop.interface", key: "not:a:valid:key" },
        capturingExec("", calls),
      ),
    );
    expect(result._tag).toBe("SettingKeyInvalid");
    expect(result).toMatchObject({ backend: "gsettings", field: "key" });
    expect(calls).toEqual([]);
  }),
);

it.effect("gsettings backend reset shells out to `gsettings reset <schema> <key>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    yield* GsettingsBackend.reset(
      { _tag: "Gsettings", schema: "org.gnome.desktop.interface", key: "clock-format" },
      capturingExec("", calls),
    );
    expect(calls).toEqual(["gsettings reset org.gnome.desktop.interface clock-format"]);
  }),
);

it.effect("gsettings backend reset rejects a malformed schema before running anything", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const result = yield* Effect.flip(
      GsettingsBackend.reset(
        { _tag: "Gsettings", schema: "not-a-valid-schema", key: "clock-format" },
        capturingExec("", calls),
      ),
    );
    expect(result._tag).toBe("SettingKeyInvalid");
    expect(calls).toEqual([]);
  }),
);

// ---------------------------------------------------------------------------
// Gsettings.ts — relocatable schema
// ---------------------------------------------------------------------------

it.effect(
  "gsettings backend addresses a relocatable schema as one combined `schema:path` argument",
  () =>
    Effect.gen(function* () {
      // Verified directly against a real relocatable schema in an
      // `ubuntu:24.04` container: `gsettings get SCHEMA:PATH KEY` — see
      // `Backend.ts`'s `GsettingsRelocatableIdentity` doc comment.
      const value = yield* GsettingsBackend.read(
        {
          _tag: "GsettingsRelocatable",
          schema: "org.example.relocatable",
          path: "/org/example/testpath1/",
          key: "greeting",
        },
        fakeExec("'hello'\n"),
      );
      expect(value).toBe("'hello'");
    }),
);

it.effect("gsettings backend write/reset also address a relocatable schema as `schema:path`", () =>
  Effect.gen(function* () {
    const identity: GsettingsRelocatableIdentity = {
      _tag: "GsettingsRelocatable",
      schema: "org.example.relocatable",
      path: "/org/example/testpath1/",
      key: "greeting",
    };
    const calls: string[] = [];
    yield* GsettingsBackend.write(identity, "'hi'", capturingExec("", calls));
    yield* GsettingsBackend.reset(identity, capturingExec("", calls));
    expect(calls).toEqual([
      "gsettings set org.example.relocatable:/org/example/testpath1/ greeting ''\\''hi'\\'''",
      "gsettings reset org.example.relocatable:/org/example/testpath1/ greeting",
    ]);
  }),
);

it.effect(
  "gsettings backend rejects a relocatable path missing its leading or trailing slash",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      // Real container errors: "Path must begin with a slash (/)" /
      // "Path must end with a slash (/)" — both client-side, exit 1, before
      // ever reaching D-Bus.
      const missingLeading = yield* Effect.flip(
        GsettingsBackend.read(
          {
            _tag: "GsettingsRelocatable",
            schema: "org.example.relocatable",
            path: "org/example/testpath1/",
            key: "greeting",
          },
          capturingExec("", calls),
        ),
      );
      expect(missingLeading).toMatchObject({ _tag: "SettingKeyInvalid", field: "path" });

      const missingTrailing = yield* Effect.flip(
        GsettingsBackend.read(
          {
            _tag: "GsettingsRelocatable",
            schema: "org.example.relocatable",
            path: "/org/example/testpath1",
            key: "greeting",
          },
          capturingExec("", calls),
        ),
      );
      expect(missingTrailing).toMatchObject({ _tag: "SettingKeyInvalid", field: "path" });

      // Neither ran a command.
      expect(calls).toEqual([]);
    }),
);

// ---------------------------------------------------------------------------
// Dconf.ts
// ---------------------------------------------------------------------------

it.effect("dconf backend reads a key's live value verbatim, GVariant quoting included", () =>
  Effect.gen(function* () {
    // `dconf read /org/gnome/desktop/interface/clock-format`.
    const value = yield* DconfBackend.read(
      { path: "/org/gnome/desktop/interface/clock-format" },
      fakeExec("'24h'\n"),
    );
    expect(value).toBe("'24h'");
  }),
);

it.effect(
  "dconf backend distinguishes an unset key (zero bytes) from an empty-string value ('')",
  () =>
    Effect.gen(function* () {
      // `dconf read /test/myuint` after `dconf reset /test/myuint`: genuinely
      // empty stdout, exit 0 — nothing was ever written here.
      const unset = yield* DconfBackend.read({ path: "/test/myuint" }, fakeExec(""));
      expect(unset).toBeUndefined();

      // `dconf write /test/mypath2 '""'` then `dconf read /test/mypath2`:
      // prints the two characters `''` — an actual empty-string *value*, not
      // an absent key.
      const empty = yield* DconfBackend.read({ path: "/test/mypath2" }, fakeExec("''\n"));
      expect(empty).toBe("''");
    }),
);

it.effect("dconf backend reads an array value's canonical GVariant text", () =>
  Effect.gen(function* () {
    // `dconf write /test/mypath '["a", "b"]'` then `dconf read /test/mypath`
    // prints back the canonical single-quoted, space-after-comma spelling.
    const value = yield* DconfBackend.read({ path: "/test/mypath" }, fakeExec("['a', 'b']\n"));
    expect(value).toBe("['a', 'b']");
  }),
);

it.effect("dconf backend write shells out to `dconf write <path> <value>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    yield* DconfBackend.write({ path: "/test/mypath" }, "['a', 'b']", capturingExec("", calls));
    expect(calls).toEqual(["dconf write /test/mypath '['\\''a'\\'', '\\''b'\\'']'"]);
  }),
);

it.effect("dconf backend reset shells out to `dconf reset <path>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    yield* DconfBackend.reset({ path: "/test/mypath" }, capturingExec("", calls));
    expect(calls).toEqual(["dconf reset /test/mypath"]);
  }),
);

it.effect("dconf backend rejects a path that isn't absolute, or that has a trailing slash", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const relative = yield* Effect.flip(
      DconfBackend.read(
        { path: "org/gnome/desktop/interface/clock-format" },
        capturingExec("", calls),
      ),
    );
    expect(relative).toMatchObject({ _tag: "SettingKeyInvalid", field: "path" });

    const trailingSlash = yield* Effect.flip(
      DconfBackend.read({ path: "/org/gnome/desktop/interface/" }, capturingExec("", calls)),
    );
    expect(trailingSlash).toMatchObject({ _tag: "SettingKeyInvalid", field: "path" });

    // Neither ran a command.
    expect(calls).toEqual([]);
  }),
);
