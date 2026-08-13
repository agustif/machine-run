import type { Exec } from "@machine-run/engine";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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
    Effect.fail({
      _tag: "CommandError" as const,
      command: props.command,
      reason: { _tag: "UnexpectedExit" as const, exitCode: 1, stderr, message: stderr },
      message: `Failed to execute command "${props.command}": ${stderr}`,
    } as never);

/** The same, but recording the command strings it was asked to run. */
const capturingExec =
  (stdout: string, calls: string[]): Exec =>
  (props) => {
    calls.push(props.command);
    return Effect.succeed({ exitCode: 0, stdout, stderr: "" });
  };

// ---------------------------------------------------------------------------
// Gsettings.ts
// ---------------------------------------------------------------------------

it.effect("gsettings backend reads a key's live value verbatim, GVariant quoting included", () =>
  Effect.gen(function* () {
    // `gsettings get org.gnome.desktop.interface clock-format` against a
    // container with `gsettings-desktop-schemas` installed.
    const value = yield* GsettingsBackend.read(
      "org.gnome.desktop.interface:clock-format",
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
      "org.gnome.desktop.interface:not-a-real-key",
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
      "org.gnome.does.not.exist:somekey",
      failingExec("No such schema ?org.gnome.does.not.exist?\n"),
    );
    expect(value).toBeUndefined();
  }),
);

it.effect("gsettings backend write shells out to `gsettings set <schema> <key> <value>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    yield* GsettingsBackend.write(
      "org.gnome.desktop.interface:clock-format",
      "'24h'",
      capturingExec("", calls),
    );
    expect(calls).toEqual(["gsettings set org.gnome.desktop.interface clock-format ''\\''24h'\\'''"]);
  }),
);

it.effect("gsettings backend rejects a key with no schema:key shape before running anything", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const result = yield* Effect.flip(
      GsettingsBackend.read("not-a-valid-key", capturingExec("", calls)),
    );
    expect(result._tag).toBe("SettingKeyInvalid");
    // Rejected before any command ran.
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
      "/org/gnome/desktop/interface/clock-format",
      fakeExec("'24h'\n"),
    );
    expect(value).toBe("'24h'");
  }),
);

it.effect("dconf backend distinguishes an unset key (zero bytes) from an empty-string value ('')", () =>
  Effect.gen(function* () {
    // `dconf read /test/myuint` after `dconf reset /test/myuint`: genuinely
    // empty stdout, exit 0 — nothing was ever written here.
    const unset = yield* DconfBackend.read("/test/myuint", fakeExec(""));
    expect(unset).toBeUndefined();

    // `dconf write /test/mypath2 '""'` then `dconf read /test/mypath2`:
    // prints the two characters `''` — an actual empty-string *value*, not
    // an absent key.
    const empty = yield* DconfBackend.read("/test/mypath2", fakeExec("''\n"));
    expect(empty).toBe("''");
  }),
);

it.effect("dconf backend reads an array value's canonical GVariant text", () =>
  Effect.gen(function* () {
    // `dconf write /test/mypath '["a", "b"]'` then `dconf read /test/mypath`
    // prints back the canonical single-quoted, space-after-comma spelling.
    const value = yield* DconfBackend.read("/test/mypath", fakeExec("['a', 'b']\n"));
    expect(value).toBe("['a', 'b']");
  }),
);

it.effect("dconf backend write shells out to `dconf write <path> <value>`", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    yield* DconfBackend.write("/test/mypath", "['a', 'b']", capturingExec("", calls));
    expect(calls).toEqual(["dconf write /test/mypath '['\\''a'\\'', '\\''b'\\'']'"]);
  }),
);

it.effect("dconf backend rejects a key that isn't an absolute, non-trailing-slash path", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const relative = yield* Effect.flip(
      DconfBackend.read("org/gnome/desktop/interface/clock-format", capturingExec("", calls)),
    );
    expect(relative._tag).toBe("SettingKeyInvalid");

    const trailingSlash = yield* Effect.flip(
      DconfBackend.read("/org/gnome/desktop/interface/", capturingExec("", calls)),
    );
    expect(trailingSlash._tag).toBe("SettingKeyInvalid");

    // Neither ran a command.
    expect(calls).toEqual([]);
  }),
);
