# system-settings: value model, container verification, and what's deferred

`@machine-run/system-settings` generalises `MacOS.Default` (in
`@machine-run/macos-defaults`) to Linux's two settings stores: `gsettings`
and `dconf`. This is the honesty-and-verification record for that package —
what was actually checked, in a real container, and the design decisions that
follow from what was found. It is pre-1.0 and has never run against a real
machine.

## The value model — opaque GVariant text, not a shared value type

`packages/macos-defaults/src/Value.ts` built a JSON-safe `PlistValue` union
with tagged `{ $data }`/`{ $date }` wrappers, because property lists have one
canonical wire format (XML) and two of its member types don't survive a JSON
round trip: `Uint8Array` and `Date` both degrade silently.

GVariant (what `gsettings`/`dconf` operate on) doesn't have that hazard.
`gsettings get`/`dconf read` already print a value as one piece of canonical
GVariant *text* — `'24h'`, `true`, `uint32 5`, `['a', 'b']` — and
`gsettings set`/`dconf write` accept that same text back as input. A GVariant
value, represented as that text, is already a plain string, and a plain
string survives `JSON.stringify`/`JSON.parse` exactly. There is nothing here
that needs a tagged wrapper the way `<data>`/`<date>` did.

So `SettingProps.value` (and `SettingsBackend.read`/`write`) carry a plain
`Schema.String` — the GVariant text form — rather than a parsed value tree.
The alternative, a `GVariantValue` union mirroring `PlistValue`, would mean
writing (or depending on) a real GVariant parser/serializer — handling
tuples, maybe-types, byte arrays, variant-in-variant wrapping — to buy back a
convenience (accepting `5` instead of requiring the caller already know
GVariant spells an unsigned 32-bit five as `uint32 5`) that a doc comment
delivers far more cheaply. The Windows registry's own type system
(`REG_DWORD`, `REG_MULTI_SZ`, `REG_BINARY`, …) is a third, again-different
system, which is the real argument against ever unifying these into one
value enum: something wide enough for all three would either miss real cases
or grow into a fourth type system nobody asked for.

This is the "backend owns its value representation, the generic resource
stays opaque" branch the task brief called out as defensible — and it mirrors
`system-packages`' own precedent: `PackageManagerBackend`'s `name` is an
opaque string interpreted in each manager's own namespace, not a shared
"package" value type across brew/apt/npm/cargo.

**The real cost of this choice**: `value` must be given in the *canonical*
GVariant spelling — exactly what `gsettings get`/`dconf read` would print —
not any spelling their parsers would accept as input. `gsettings set`/`dconf
write` tolerate looser syntax (an unquoted `12h` for a string key, no space
after a comma in an array); `get`/`read` only ever print one canonical
spelling back. Since `matches` compares `value` textually against a live
read, a `value` written in a non-canonical spelling would apply successfully
once and then report drift on every subsequent plan, forever. This is
documented on `SettingProps.value` itself; the honest mitigation is "copy the
value from a real `gsettings get`/`dconf read`," not a canonicalizer — building
one would mean the GVariant parser this section just argued against.

## What was verified in a container, and how

All of the following is from `docker run --rm ubuntu:24.04`, installing
`dconf-cli dconf-gsettings-backend libglib2.0-bin gsettings-desktop-schemas
dbus dbus-x11`, on 2026-08-13. Nothing below is guessed or extrapolated from
documentation.

**A bare Ubuntu image has `gsettings`/`dconf` binaries but zero schemas.**
`gsettings list-schemas` prints `No schemas installed` until
`gsettings-desktop-schemas` (the GNOME desktop's own schemas, e.g.
`org.gnome.desktop.interface`) is installed. This package assumes that
package (or an equivalent schema provider) is present for `gsettings` to be
useful at all; `dconf` needs no schema and works against any bare image.

**`gsettings set` can report success while doing nothing.** With no session
D-Bus reachable — no `DBUS_SESSION_BUS_ADDRESS`, no X11 `$DISPLAY` to
autolaunch one, which is exactly the situation a bare SSH session, cron, or a
container puts a reconciler in — `gsettings set` prints

```
(process:474): dconf-WARNING **: failed to commit changes to dconf: Cannot autolaunch D-Bus without X11 $DISPLAY
```

to stderr **and exits 0**. The key is left completely unchanged; a
subsequent `gsettings get` still returns the old value. This is the single
most important thing this verification found, and it's why `Setting.ts`'s
`apply` always re-reads the key immediately after writing it and raises a
typed `SettingWriteNotObserved` if the value didn't actually change, rather
than trusting the write's exit code the way `MacOS.Default.apply` trusts
`defaults write`'s.

**`dconf write` fails loudly in the identical scenario**: `error: Cannot
autolaunch D-Bus without X11 $DISPLAY`, exit 1. This is the concrete
"differs meaningfully" the task brief asked about — it's the reason `dconf`
is its own backend rather than a thin wrapper delegating to `gsettings`, and
also the reason `Setting.ts`'s read-back check isn't backend-specific: it
makes both backends behave identically (loud, typed failure) in a situation
where only one of them fails loudly on its own.

**Canonical read output, per type** (`gsettings get`/`dconf read`, after a
matching `set`/`write`):

| Type | Written as | Read back as |
|---|---|---|
| string | `12h` (bare, gsettings-only) or `"24h"` | `'24h'` |
| boolean | `true` | `true` |
| int32 | `32` | `32` |
| double | `1.25` | `1.25` |
| uint32 | `uint32 5` | `uint32 5` |
| array of strings | `["a", "b"]` | `['a', 'b']` |
| dict | `{"k": "v"}` | `{'k': 'v'}` |
| empty string | `""` | `''` |

**An unset `dconf` path reads as zero bytes on stdout, exit 0** — genuinely
indistinguishable from an empty string only because an actual empty-string
*value* prints as the two characters `''` (its GVariant text form), never as
nothing. `DconfBackend.read` relies on exactly that distinction (trim to `""`
→ absent; trim to `''` → the empty string).

**`gsettings` always has an answer for a key in an installed schema** — reset
a key and `get` still exits 0, returning the schema's default. There is no
"absent" state for a valid `gsettings` key the way there is for a `dconf`
path; `observe` only reports "absent" when the schema or key name itself
doesn't resolve (`No such schema`/`No such key`, both exit 1).

**Malformed GVariant is rejected client-side**, before touching D-Bus at all
— confirmed for both `gsettings set` (`unknown keyword: notabool`, exit 1)
and `dconf write` (`error: 0-14:unknown keyword`, exit 2). Exit codes differ
between the two CLIs for the same failure class, which is exactly why
`Setting.ts` never branches on a specific exit code or message substring —
only on "did the command fail at all" (`observe`, collapsing any failure to
absent, the same idiom `MacOS.Default.observe` already uses) and "did the
value actually change" (`apply`'s read-back).

## `address`: per key, not per store

`MacOS.Default` addresses per *domain* (`defaults:${domain}`), because
`defaults write` rewrites the whole domain's plist file, so two keys in one
domain are two read-modify-write cycles over the same file and must
serialise. Neither `gsettings` nor `dconf` works that way: each key/path is
its own independent write through the store's own service (`dconf-service`,
reached over D-Bus), not a shared file. So `System.Setting.address` is
`${backend}:${key}` — fine-grained enough that two resources naming the same
key still serialise, while two different keys (even under the same schema)
reconcile in parallel. Nothing found in the container testing here suggests
otherwise, but this repo has never load-tested concurrent writes to
`dconf-service` itself; that would be the thing to check before relying on
this at real concurrency.

## The unfinished half of the D-Bus finding: `unapply`, and why `observe` still doesn't check for a bus

Re-verified in the same kind of container (`ubuntu:24.04`, same packages) on
2026-08-14, extending the original finding to `reset`:

- **`gsettings reset` shares `gsettings set`'s exact silent no-op.** With no
  session D-Bus reachable, `gsettings reset org.gnome.desktop.interface
  clock-format` prints the identical `dconf-WARNING **: failed to commit
  changes to dconf: Cannot autolaunch D-Bus without X11 $DISPLAY` and exits
  `0`, leaving the key completely unchanged. With a session bus reachable
  (`dbus-run-session`), it genuinely restores the schema default (verified:
  set to `'12h'`, reset, read back `'24h'`).
- **`dconf reset` shares `dconf write`'s exact fail-loud behaviour.** No
  session bus: `error: Cannot autolaunch D-Bus without X11 $DISPLAY`, exit
  `1`. With a bus: a genuine revert (`dconf read` afterward prints zero
  bytes, exit `0` — back to "nothing was ever written here").

This is why `unapply` (now implemented — `gsettings reset`/`dconf reset`) uses
the identical read-back discipline `apply` already used for `write`: reset,
then re-read, and fail loudly (`SettingResetNotObserved`) if the value never
actually changed away from what this resource had recorded writing. Unlike
`apply`, `unapply` doesn't know the *target* value to compare against (a
gsettings key's schema default isn't something this resource ever learns —
there's no client-side way to ask "what would this be if never set"), so the
check is inverted: "did the value change at all from what we wrote", not "did
it become exactly X". That's still a real, non-tautological check — a
silently-no-op'd reset leaves `read` returning precisely the value this
resource itself wrote, which the check catches.

**Decision on the other unfinished-half item — `observe` raising a typed
error when `DBUS_SESSION_BUS_ADDRESS` is absent — is not to add it.**
Reasoning, backed by this container run:

1. **Reads never depend on the bus.** Every `gsettings get`/`dconf read` in
   both this session's and the original session's container testing answered
   correctly with no session bus reachable at all. `observe` (and therefore
   `plan`) is not where the lie happens — it already reports accurate live
   state on a headless machine.
2. **The env var is neither necessary nor sufficient** as a proxy for "will a
   write commit": some session setups reach a bus via
   `$XDG_RUNTIME_DIR/bus` autodiscovery without ever exporting the variable,
   and a stale/dead address can be set while nothing is actually listening.
   Gating `observe` on its presence would fail plans on machines where
   nothing is wrong, and pass machines where the address is stale — a worse
   signal than what already exists.
3. **The actual failure mode the task brief described — "successful apply,
   drift forever, no explanation" — is already closed**, and was closed
   before this session started: `SettingWriteNotObserved` (`Setting.ts`) has
   re-read every write since the very first commit that introduced
   `System.Setting` (`fa95d27`). A headless `apply` today does not look
   successful when it silently wasn't: it raises a typed, explicit error
   naming the D-Bus root cause and recommending the `dconf` backend, on the
   very run that tried to write, not two plans later with no explanation.
   `unapply` now gets the identical discipline for `reset`.

So the honest status of this TASKS.md item is: the mechanism it asked for
already existed (behavior-verified, not env-var-sniffed), and this session's
job was to confirm that, extend the same discipline to `unapply`, and record
*why* a more literal reading of the task ("check the env var") would have
been a strictly worse fix layered on top of a better one already in place.

## What's deferred, and why — not guessed

- **macOS is not a third backend id.** `MacDefaultProps.value` is a
  `PlistValueSchema` (a JSON-safe tree); `SettingProps.value` here is a plain
  string. Those are incompatible shapes for one shared `Props` schema, so
  putting macOS into this same registry would mean widening
  `SettingProps.value` into a discriminated union keyed by backend (roughly
  `{ backend: "macos"; value: PlistValue } | { backend: "gsettings" |
  "dconf"; value: string }`), which is a real, separate schema-migration
  task — not something to fold into this change, and not something to do to
  `macos-defaults/src/Default.ts` while another agent is actively writing
  tests against it. The task brief was explicit that converting
  `MacOS.Default` into an alias is a deliberate follow-up, not part of this
  package. `MacOS.Default` already follows the identical
  `Reconciler`/backend-seam shape (observe live state, `matches` on
  canonicalised text, domain-scoped locking) — it just isn't wired into
  *this* registry.
- **Windows registry `SettingsBackend` is not implemented.** No Windows
  target is reachable from this machine (same gap already tracked in
  `docs/TASKS.md`'s P2-Windows section and `docs/system-packages-notes.md`
  for `winget`/`choco`). Guessing at `reg.exe`/PowerShell registry cmdlet
  flags without a real target to run them against is exactly the mistake
  rule 5 warns about, so it's left as the tracked gap it already was rather
  than invented here.
- **Relocatable GSettings schemas** (which need a third, path, argument
  beyond `schema-id:key-name`) are not supported by `GsettingsBackend`'s key
  parser. Not needed for the fixed, non-relocatable schemas
  (`org.gnome.desktop.*`) this was verified against.
- **Concurrent-write behaviour of `dconf-service` itself** (does it truly
  serialise two simultaneous writes to *different* keys safely, at scale)
  was not load-tested — only single-writer sequential behaviour was
  confirmed in the container. The per-key `address` choice above is reasoned
  from how the tool is documented and observed to behave, not from a stress
  test.

## Provider wiring: no private `CommandExecutorLive`

`system-settings/src/Providers.ts` does **not** build its own
`CommandExecutorLive()` the way `macos-defaults/src/Providers.ts` does. It
follows `system-packages`/`secrets` instead, which leave `CommandExecutor`
(and `Backups`/`FileLock`) to bubble up from the composing recipe's shared
instance — see their own `Providers.ts` doc comments. `macos-defaults` is the
outlier here, not the pattern; this wasn't changed since that file belongs to
another agent's current work.

## Root wiring this package still needs

This package was built without touching root `tsconfig.json` or root
`package.json`, per the task's scope. Two things still need doing outside
this package for it to build as part of the full monorepo `tsc -b` and to be
scoped into `tsconfig.tests.json`'s tests project:

- Root `tsconfig.json`: add `{ "path": "packages/system-settings" }` to
  `references`.
- Root `tsconfig.tests.json`: add the same entry.

`npm install` was not run (no dependency on it was needed —
`@machine-run/core` and `@machine-run/engine` were already built and
symlinked into root `node_modules/@machine-run/`), and root `package.json`
needs no edit at all: its `workspaces` glob (`packages/*`) already picks up
this package automatically.
