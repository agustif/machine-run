import type { CommandError } from "alchemy/Command";
import type { Exec } from "@machine-run/engine";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Every settings store this repo knows how to read from and write to.
 *
 * Only Linux stores are here. macOS's equivalent is
 * `@machine-run/macos-defaults`'s `MacOS.Default`, deliberately left as its
 * own resource rather than folded in as a third id — see
 * `docs/settings-notes.md` for why forcing it in here would mean widening
 * `SettingProps.value` from a plain string into a union keyed by backend, and
 * why that's a follow-up rather than part of this change. The Windows
 * registry is a documented gap, not a guess — also in `docs/settings-notes.md`
 * and `docs/TASKS.md`.
 */
export const SettingsBackendId = Schema.Literals(["gsettings", "dconf"]);

export type SettingsBackendId = typeof SettingsBackendId.Type;

/**
 * A key this backend was asked to read or write is not in the shape it
 * accepts. Caught before any command runs, so it carries no `CommandError`
 * cause — mirrors `secrets`' `SecretRefInvalid`.
 */
export class SettingKeyInvalid extends Data.TaggedError("SettingKeyInvalid")<{
  backend: SettingsBackendId;
  key: string;
  expected: string;
}> {
  override get message() {
    return `"${this.key}" is not a valid ${this.backend} key. Expected ${this.expected}.`;
  }
}

export type SettingsError = CommandError | SettingKeyInvalid;

/**
 * The shared shape every platform settings-store backend implements — one
 * key, read or written, in whichever store the id names. This is the atomic
 * seam `System.Setting` dispatches through: adding a store means writing one
 * `backends/<Name>.ts` module and one id, never touching the resource.
 *
 * ## The value model — and why there isn't one
 *
 * `defaults`/`plist` (`@machine-run/macos-defaults`), GSettings/dconf's
 * GVariant, and the Windows registry (`REG_SZ`, `REG_DWORD`, …) are three
 * genuinely different type systems, not three encodings of one type system.
 * `packages/macos-defaults/src/Value.ts` had to invent a JSON-safe
 * `PlistValue` union with tagged `{ $data }`/`{ $date }` wrappers because
 * property lists have exactly one canonical wire format (XML) and two of its
 * member types — `<data>` and `<date>` — degrade silently across a JSON round
 * trip (`Uint8Array` and `Date` do not survive `JSON.stringify`/`JSON.parse`).
 *
 * GVariant has no such hazard here: `gsettings get`/`dconf read` already
 * *print* a value as one canonical piece of GVariant text — `'24h'`, `true`,
 * `uint32 5`, `['a', 'b']` — and `gsettings set`/`dconf write` accept that
 * same text back as input. A GVariant value, represented as that text, is
 * already a plain string, and a plain string is exactly the thing a JSON
 * round trip preserves byte-for-byte. There is nothing here for a tagged
 * wrapper to rescue.
 *
 * So `read`/`write` below move a plain `string` — the GVariant text form —
 * rather than a parsed value tree. Building a `GVariantValue` union the way
 * `PlistValue` exists would mean writing (or depending on) a GVariant
 * parser/serializer to buy back a convenience — accepting `5` instead of
 * requiring the caller to already know GVariant spells an unsigned 32-bit 5
 * as `uint32 5` — that a doc comment on `SettingProps.value` delivers far
 * more cheaply, without taking on tuples, maybe-types, byte arrays and
 * variant-in-variant wrapping just to get two backends' worth of scalars and
 * arrays right. See `docs/settings-notes.md` for the container-verified
 * examples of what that text actually looks like, and for why the registry's
 * own type system (`REG_DWORD`, `REG_MULTI_SZ`, `REG_BINARY`, …) is a third
 * reason this shouldn't be unified: a shared enum wide enough for all three
 * stores would either miss real cases or have to grow into a fourth type
 * system nobody asked for.
 *
 * This mirrors `system-packages`' own precedent: `PackageManagerBackend`
 * doesn't model a package's version constraints or install options in one
 * shared shape either — `name` is opaque, and each backend interprets it in
 * its own namespace. The abstraction here lives at the backend layer, not in
 * a shared value type the generic resource would have to understand.
 *
 * Every method takes an {@link Exec} — the reconciler's own command-running
 * capability, already bound to whichever session belongs to the current
 * phase — never a `CommandExecutor` or a session directly, so a backend can
 * never run a command outside the reconciler's own bookkeeping.
 */
export interface SettingsBackend {
  readonly id: SettingsBackendId;
  /**
   * The live value at `key`, as GVariant text, or `undefined` if nothing is
   * there.
   *
   * "Nothing is there" covers a genuinely unset `dconf` path *and* a
   * `gsettings` key or schema that doesn't parse or doesn't exist — the same
   * collapse `MacOS.Default`'s `observe` makes for a missing `defaults`
   * domain/key, and for the same reason: an absent value is an ordinary
   * state to converge from, not a failure. See `docs/settings-notes.md` for
   * the container output this is verified against.
   */
  readonly read: (key: string, exec: Exec) => Effect.Effect<string | undefined, SettingsError>;
  /** Writes `value` (GVariant text) to `key`. Does not itself verify the write stuck — see `Setting.ts`. */
  readonly write: (key: string, value: string, exec: Exec) => Effect.Effect<void, SettingsError>;
  /**
   * Reverts `key` to whatever it held before this store ever recorded an
   * explicit value for it: `gsettings reset` restores the schema's own
   * default (a valid gsettings key has no "unset" state — see `read`'s doc
   * comment), `dconf reset` removes the override entirely, returning the
   * path to "nothing was ever written here". Both are real, tool-provided
   * reverts, which is what makes {@link Setting}'s `unapply` an honest undo
   * rather than a fabricated one — see `@machine-run/engine`'s
   * `Reconciler.unapply` doc comment on when a resource may implement one at
   * all.
   *
   * Shares `write`'s exact no-session-D-Bus hazard, container-verified for
   * both directions: `gsettings reset` exits 0 while leaving the key
   * completely unchanged with no reachable session bus, identically to
   * `gsettings set`; `dconf reset` fails loudly the same way `dconf write`
   * does (`error: Cannot autolaunch D-Bus without X11 $DISPLAY`, exit 1).
   * Does not itself verify the reset stuck — `Setting.ts`'s `unapply`
   * re-reads afterward, the same discipline `apply` already applies to
   * `write`.
   */
  readonly reset: (key: string, exec: Exec) => Effect.Effect<void, SettingsError>;
}
