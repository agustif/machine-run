import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import { type SettingsBackend, SettingKeyInvalid } from "../Backend.ts";

const EXPECTED = 'an absolute dconf path starting, but not ending, with "/", e.g. "/org/gnome/desktop/interface/clock-format"';

const isValidPath = (key: string): boolean => key.startsWith("/") && !key.endsWith("/");

const checkKey = (key: string): Effect.Effect<string, SettingKeyInvalid> =>
  isValidPath(key)
    ? Effect.succeed(key)
    : Effect.fail(new SettingKeyInvalid({ backend: "dconf", key, expected: EXPECTED }));

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
export const DconfBackend: SettingsBackend = {
  id: "dconf",

  read: (key, exec) =>
    checkKey(key).pipe(
      Effect.flatMap((path) =>
        exec({ command: Sh.sh("dconf", "read", path), shell: true }).pipe(
          Effect.map((result) => result.stdout.trim()),
          Effect.orElseSucceed(() => ""),
        ),
      ),
      Effect.map((trimmed) => (trimmed === "" ? undefined : trimmed)),
    ),

  write: (key, value, exec) =>
    checkKey(key).pipe(
      Effect.flatMap((path) => exec({ command: Sh.sh("dconf", "write", path, value), shell: true })),
      Effect.asVoid,
    ),
};
