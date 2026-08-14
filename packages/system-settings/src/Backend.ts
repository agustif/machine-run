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
 *
 * This is the CLI/tool identifier — `"gsettings"` covers both of
 * `SettingProps`'s `Gsettings` and `GsettingsRelocatable` cases, since both
 * are read and written through the same `gsettings` binary. It is a coarser
 * grouping than `SettingProps`'s own `_tag`, kept only for what genuinely is
 * tool-level (error messages, which binary a doc comment should name), not
 * for dispatch — dispatch is `Match.tagsExhaustive` over `SettingProps`
 * itself, in `Setting.ts`.
 */
export const SettingsBackendId = Schema.Literals(["gsettings", "dconf"]);

export type SettingsBackendId = typeof SettingsBackendId.Type;

/**
 * One field of a key this backend was asked to read or write is not in the
 * shape that field requires — an unparsable `schema`, a `path` missing its
 * leading or trailing slash, a `key` with a character GSettings key names
 * never carry. Caught before any command runs, so it carries no
 * `CommandError` cause — mirrors `secrets`' `SecretRefInvalid`.
 *
 * Unlike the previous shape (a single `key: string`, split apart by a
 * regex), `field`/`value` name exactly which part of an already-structured
 * {@link GsettingsIdentity}/{@link GsettingsRelocatableIdentity}/{@link
 * DconfIdentity} failed, because there is no longer one combined string to
 * blame — `SettingProps`'s cases (`Setting.ts`) hand each backend already-
 * separated fields, so this error is about a field's *content*, not its
 * shape as a substring of something bigger.
 */
export class SettingKeyInvalid extends Data.TaggedError("SettingKeyInvalid")<{
  backend: SettingsBackendId;
  field: string;
  value: string;
  expected: string;
}> {
  override get message() {
    return `"${this.value}" is not a valid ${this.backend} ${this.field}. Expected ${this.expected}.`;
  }
}

export type SettingsError = CommandError | SettingKeyInvalid;

/**
 * What identifies one ordinary (non-relocatable) GSettings key: a schema id
 * (`"org.gnome.desktop.interface"`) and a key name within it
 * (`"clock-format"`). `gsettings get/set/reset SCHEMA KEY` takes exactly
 * these two, as two separate arguments — never a combined
 * `"schema:key-name"` string a caller could hand to the wrong backend or
 * mistype the separator on. See `backends/Gsettings.ts` for the field-shape
 * validation (`GsettingsBackend`'s `checkSchema`/`checkKey`).
 */
export const GsettingsIdentity = Schema.TaggedStruct("Gsettings", {
  schema: Schema.String,
  key: Schema.String,
});
export type GsettingsIdentity = typeof GsettingsIdentity.Type;

/**
 * What identifies one key in a *relocatable* GSettings schema — one with no
 * fixed dconf path built in (per-profile terminal settings being the common
 * real example), which `gsettings` therefore requires a `path` for in
 * addition to `schema`/`key`. Verified directly against a real relocatable
 * schema in an `ubuntu:24.04` container (`docs/settings-notes.md`):
 * `gsettings get SCHEMA:PATH KEY`, where `PATH` is a dconf-style path that
 * must both begin and end with `/` (confirmed via the CLI's own errors,
 * `"Path must begin with a slash (/)"` / `"Path must end with a slash (/)"`,
 * when either is missing) — a different shape from {@link DconfIdentity}'s
 * `path`, which must *not* end with `/`. `gsettings get SCHEMA key` (no
 * path) against a relocatable schema fails outright
 * (`"Schema '...' is relocatable (path must be specified)"`), which is
 * exactly the illegal combination `SettingProps`'s separate `Gsettings`/
 * `GsettingsRelocatable` cases (`Setting.ts`) make unrepresentable: there is
 * no `path` field to omit-when-it-shouldn't-be, or forget-when-it-must-be,
 * because a relocatable key is a different case with its own required field,
 * not an optional add-on to the ordinary one.
 */
export const GsettingsRelocatableIdentity = Schema.TaggedStruct("GsettingsRelocatable", {
  schema: Schema.String,
  path: Schema.String,
  key: Schema.String,
});
export type GsettingsRelocatableIdentity = typeof GsettingsRelocatableIdentity.Type;

/**
 * What identifies one `dconf` key: an absolute path
 * (`/org/gnome/desktop/interface/clock-format`) that must *not* end with
 * `/` — the opposite trailing-slash rule from {@link
 * GsettingsRelocatableIdentity}'s `path`, because a dconf *key* path names
 * one value while a gsettings relocatable *schema* path names a directory
 * prefix under which a whole schema's keys live. `dconf read/write/reset`
 * take this single path as their only positional argument.
 */
export const DconfIdentity = Schema.Struct({ path: Schema.String });
export type DconfIdentity = typeof DconfIdentity.Type;

/**
 * The shared shape every platform settings-store backend implements — one
 * key, read or written, in whichever store the id names. This is the atomic
 * seam `System.Setting` dispatches through: adding a store means writing one
 * `backends/<Name>.ts` module and one id, never touching the resource.
 *
 * Parametrized over `Identity` — {@link GsettingsIdentity} or {@link
 * GsettingsRelocatableIdentity} (both handled by the one `gsettings`
 * backend, since both go through the same CLI) or {@link DconfIdentity} —
 * rather than a bare `key: Schema.String` a caller had to spell in a
 * backend-specific combined-string grammar (`"schema:key-name"`, an
 * absolute path, …) and this module had to re-parse and validate. `Setting.
 * ts`'s `SettingProps` is a `Schema.TaggedUnion` precisely so each case can
 * hand a backend already-structured fields instead.
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
export interface SettingsBackend<Identity> {
  readonly id: SettingsBackendId;
  /**
   * The live value at `identity`, as GVariant text, or `undefined` if
   * nothing is there.
   *
   * "Nothing is there" covers a genuinely unset `dconf` path *and* a
   * `gsettings` key or schema that doesn't parse or doesn't exist — the same
   * collapse `MacOS.Default`'s `observe` makes for a missing `defaults`
   * domain/key, and for the same reason: an absent value is an ordinary
   * state to converge from, not a failure. See `docs/settings-notes.md` for
   * the container output this is verified against.
   */
  readonly read: (
    identity: Identity,
    exec: Exec,
  ) => Effect.Effect<string | undefined, SettingsError>;
  /** Writes `value` (GVariant text) to `identity`. Does not itself verify the write stuck — see `Setting.ts`. */
  readonly write: (
    identity: Identity,
    value: string,
    exec: Exec,
  ) => Effect.Effect<void, SettingsError>;
  /**
   * Reverts `identity` to whatever it held before this store ever recorded
   * an explicit value for it: `gsettings reset` restores the schema's own
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
  readonly reset: (identity: Identity, exec: Exec) => Effect.Effect<void, SettingsError>;
}
