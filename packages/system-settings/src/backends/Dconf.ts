import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import { type DconfIdentity, type SettingsBackend, SettingKeyInvalid } from "../Backend.ts";

const EXPECTED =
  'an absolute dconf path starting, but not ending, with "/", e.g. "/org/gnome/desktop/interface/clock-format"';

const isValidPath = (path: string): boolean => path.startsWith("/") && !path.endsWith("/");

const checkPath = (path: string): Effect.Effect<string, SettingKeyInvalid> =>
  isValidPath(path)
    ? Effect.succeed(path)
    : Effect.fail(
        new SettingKeyInvalid({ backend: "dconf", field: "path", value: path, expected: EXPECTED }),
      );

/**
 * Raw `dconf`, via its own CLI — the layer `gsettings` sits on top of.
 *
 * Verified in the same `ubuntu:24.04` container as `Gsettings.ts` (see
 * `docs/settings-notes.md`). Two differences from `gsettings` are real
 * enough to justify a separate backend rather than one that just shells out
 * to the other:
 *
 * - **No schema required.** `dconf write /any/path 'value'` succeeds against
 *   a path no schema declares; `gsettings` refuses anything outside an
 *   installed schema ("No such schema"). Useful for a key this repo has no
 *   GSettings schema for, or a machine where the relevant schema package
 *   isn't installed at all.
 * - **Fails loudly, not silently, with no session D-Bus.** The exact
 *   scenario that makes `gsettings set` exit 0 while doing nothing (see
 *   `Gsettings.ts`) makes `dconf write` exit 1 with
 *   `error: Cannot autolaunch D-Bus without X11 $DISPLAY` — confirmed in the
 *   same container run. `Setting.ts`'s read-back-after-write check makes
 *   this repo's actual behaviour identical either way, but it's worth
 *   recording that `dconf` is the more honest of the two CLIs here.
 *
 * `dconf read` of a path nothing was ever written to prints nothing at all
 * (zero bytes, exit 0) — genuinely indistinguishable from "absent" only
 * because an actual empty-string *value* prints as the two characters `''`
 * (its GVariant text form), never as zero bytes. `read` below relies on
 * exactly that distinction.
 */
export const DconfBackend: SettingsBackend<DconfIdentity> = {
  id: "dconf",

  read: ({ path }, exec) =>
    checkPath(path).pipe(
      Effect.flatMap((checked) =>
        exec({ command: Sh.sh("dconf", "read", checked), shell: true }).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ),
      Effect.map((trimmed) => (trimmed === "" ? undefined : trimmed)),
    ),

  write: ({ path }, value, exec) =>
    checkPath(path).pipe(
      Effect.flatMap((checked) =>
        exec({ command: Sh.sh("dconf", "write", checked, value), shell: true }),
      ),
      Effect.asVoid,
    ),

  /**
   * Verified in the same container, on 2026-08-14: with no session D-Bus
   * reachable, `dconf reset /test/mypath` fails loudly (`error: Cannot
   * autolaunch D-Bus without X11 $DISPLAY`, exit 1) — the same fail-loud
   * behaviour `write` already has, not a distinct code path that happens to
   * differ. With a session bus reachable, `dconf reset` genuinely removes
   * the override (`dconf read` afterward prints zero bytes, exit 0).
   */
  reset: ({ path }, exec) =>
    checkPath(path).pipe(
      Effect.flatMap((checked) => exec({ command: Sh.sh("dconf", "reset", checked), shell: true })),
      Effect.asVoid,
    ),
};
