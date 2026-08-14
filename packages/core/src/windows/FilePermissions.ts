import * as Schema from "effect/Schema";

/**
 * A POSIX `mode`'s *intent*, expressed platform-neutrally, and the pure
 * translation of that intent onto Windows' access-control model.
 *
 * Full research trail — the evidence this module is built on, with exact
 * commands, exact tool output, and citations — is
 * `docs/notes/windows-permissions.md`. Read it before changing the mapping
 * below; every constant here answers a question that document asks and
 * answers first.
 *
 * ## Why a domain type, not a direct mode-to-icacls-string function
 *
 * `chmod` and `icacls` are both *renderers* of the same intent — "who may
 * read, write, or execute this" — not equivalent operations translated
 * directly into each other. Keeping that intent as a value (`FilePermissions`)
 * rather than threading a bare `number` through two backends means the one
 * genuinely lossy step — deciding what a POSIX bit means in Windows terms —
 * happens once, in {@link fromPosixMode}, in one place that can be read,
 * tested and cited, instead of being re-decided (possibly differently) inside
 * every call site that happens to need an `icacls` command.
 *
 * ## What this does NOT claim
 *
 * This is an *approximation of intent*, not a faithful encoding. Three gaps
 * are structural, not implementation gaps to be fixed later:
 *
 * - **POSIX "group" has no Windows counterpart on a personal machine.**
 *   There is no ambient "this machine's group of trusted accounts" the way
 *   `staff` or `wheel` exists on POSIX. `BUILTIN\Users` (every local account)
 *   is the least-wrong stand-in, but it is broader than most POSIX groups in
 *   practice and case-by-case wrong in general (see the notes doc, §3).
 * - **The POSIX execute bit has no Windows analogue on a *file*.** Windows
 *   decides whether a file runs by its extension and shell association, not
 *   by an access-control bit distinct from Read. Granting or withholding the
 *   Windows `X` right on a regular file changes nothing about whether it
 *   executes. `x` on a *directory* is different and genuinely maps — see
 *   below.
 * - **Administrators and SYSTEM are not, and cannot be made, "nobody."**
 *   Any translation that tries to lock a file down the way `0600` does on
 *   POSIX still leaves it readable by an administrator taking ownership. This
 *   is the same shape as POSIX root bypassing file permissions — a fair
 *   analogy, not a flaw unique to this mapping — but it means "no one else
 *   can read this" is never literally true on either platform for a
 *   sufnot-quite-root-proof secret.
 */

export const PermissionsTarget = Schema.Literals(["file", "directory"]);
export type PermissionsTarget = typeof PermissionsTarget.Type;

/** One POSIX permission triad (owner, group, or other) as three booleans. */
export const PermissionClass = Schema.Struct({
  read: Schema.Boolean,
  write: Schema.Boolean,
  execute: Schema.Boolean,
});
export type PermissionClass = typeof PermissionClass.Type;

/**
 * A POSIX mode's intent, decomposed into its three classes. `target`
 * disambiguates the one bit whose meaning depends on it: `execute` on a file
 * is (per this module's doc comment) unmappable, while `execute` on a
 * directory is "may be traversed" and maps cleanly to Windows' Traverse
 * Folder right.
 */
export const FilePermissions = Schema.Struct({
  target: PermissionsTarget,
  owner: PermissionClass,
  group: PermissionClass,
  other: PermissionClass,
});
export type FilePermissions = typeof FilePermissions.Type;

const classFromDigit = (digit: number): PermissionClass => ({
  read: (digit & 0b100) !== 0,
  write: (digit & 0b010) !== 0,
  execute: (digit & 0b001) !== 0,
});

const digitFromClass = (permissionClass: PermissionClass): number =>
  (Number(permissionClass.read) << 2) |
  (Number(permissionClass.write) << 1) |
  Number(permissionClass.execute);

/** Decomposes a POSIX mode (e.g. `0o600`) into its owner/group/other intent. */
export const fromPosixMode = (mode: number, target: PermissionsTarget): FilePermissions => ({
  target,
  owner: classFromDigit((mode >> 6) & 0o7),
  group: classFromDigit((mode >> 3) & 0o7),
  other: classFromDigit(mode & 0o7),
});

/**
 * Recomposes a POSIX mode from its intent. `toPosixMode(fromPosixMode(m, t))
 * === m` for every `m` in `0..0o777` — this direction is lossless, since
 * POSIX mode *is* the representation `FilePermissions` was built to describe.
 * The lossy direction is {@link toWindowsAclPlan}, not this one.
 */
export const toPosixMode = (permissions: FilePermissions): number =>
  (digitFromClass(permissions.owner) << 6) |
  (digitFromClass(permissions.group) << 3) |
  digitFromClass(permissions.other);

/**
 * The closed set of tokens `icacls` accepts after a Sid in `/grant[:r]
 * Sid:perm`, restricted to the advanced (parenthesised, comma-joinable)
 * rights this module renders — never the *simple* letters (`F`, `M`, `RX`,
 * `R`, `W`, `D`, `N`).
 *
 * Simple rights are deliberately not used here: they are named bundles that
 * do not line up with POSIX's three independent bits. `M` (Modify), the
 * closest simple right to "read plus write", also grants Delete — broader
 * than what `0o600` asks for. Composing the advanced rights individually is
 * the only way to grant exactly "read and write, nothing else" rather than
 * the nearest named Windows bundle. See docs/notes/windows-permissions.md §3
 * for the read-back of Microsoft's own documented Basic-to-Advanced mapping
 * this list is built from.
 */
export const IcaclsRight = Schema.Literals([
  "RD", // Read data / list directory
  "WD", // Write data / create file
  "AD", // Append data / create subdirectory
  "REA", // Read extended attributes
  "WEA", // Write extended attributes
  "RA", // Read attributes
  "WA", // Write attributes
  "X", // Execute file / traverse directory
  "DC", // Delete child
  "RC", // Read permissions (read control)
  "S", // Synchronize
]);
export type IcaclsRight = typeof IcaclsRight.Type;

/**
 * Rights granted for "read", "write" and "execute" respectively, as the
 * advanced-rights bundle each POSIX bit decomposes to. `RC` and `S` ride
 * along with `read` rather than being unconditional: a principal granted
 * nothing gets no ACE at all (see {@link toWindowsAclPlan}), and a principal
 * granted only `write` genuinely has no standing reason to read the ACL back
 * (`RC`) either — though in practice Windows requires `RC` for many
 * write-adjacent operations to succeed at all, which is exactly the kind of
 * platform wrinkle this module does not attempt to model exhaustively. Read
 * docs/notes/windows-permissions.md before tightening this.
 */
const READ_RIGHTS: readonly IcaclsRight[] = ["RD", "REA", "RA", "RC", "S"];
const WRITE_RIGHTS: readonly IcaclsRight[] = ["WD", "AD", "WEA", "WA"];
const EXECUTE_RIGHTS: readonly IcaclsRight[] = ["X"];

/**
 * The advanced rights one `PermissionClass` translates to, deduplicated and
 * in a stable order. `target` only matters for documentation here — `read`
 * and `write` decompose the same way on a file or a directory, and `execute`
 * always renders to `X`; whether `X` is *meaningful* for the target is the
 * point made in this module's header comment, not something the renderer
 * itself can act on.
 */
export const rightsForClass = (permissionClass: PermissionClass): readonly IcaclsRight[] => {
  const groups: ReadonlyArray<readonly [boolean, readonly IcaclsRight[]]> = [
    [permissionClass.read, READ_RIGHTS],
    [permissionClass.write, WRITE_RIGHTS],
    [permissionClass.execute, EXECUTE_RIGHTS],
  ];
  const rights = groups.filter(([enabled]) => enabled).flatMap(([, bundle]) => bundle);
  return [...new Set(rights)];
};

/**
 * The three well-known SIDs this module approximates POSIX owner/group/other
 * with. Every one is cited in docs/notes/windows-permissions.md §1 against
 * Microsoft's own well-known-SID reference.
 *
 * - `owner` → `OWNER RIGHTS` (`S-1-3-4`, Windows Vista+): a placeholder SID
 *   that always resolves to whoever currently owns the object, so the
 *   translation never needs to look up (or hard-code) a username. This is
 *   the one genuinely faithful entry in this table — see the notes doc for
 *   why it exists and what it changed when introduced.
 * - `group` → `BUILTIN\Users` (`S-1-5-32-545`): every local account. The
 *   least-wrong stand-in for "this machine's other trusted accounts", and
 *   the gap this module is most honest about — see the header comment.
 * - `other` → `Everyone` (`S-1-1-0`): the universal well-known SID for "all
 *   users", including anonymous/network logons `BUILTIN\Users` excludes.
 *   POSIX "other" and Windows "Everyone" are the closest real match in this
 *   whole table.
 *
 * Numeric `*S-...` form, not the localized friendly name: `icacls` accepts
 * either, but friendly names for built-in identities only resolve on an
 * English-language system (documented on the Microsoft Learn `icacls` page
 * cited in the notes doc). The numeric form is language-independent.
 */
export const WELL_KNOWN_PRINCIPALS = {
  owner: "*S-1-3-4",
  group: "*S-1-5-32-545",
  other: "*S-1-1-0",
} satisfies Record<"owner" | "group" | "other", string>;

/**
 * Every string `icacls <path>`'s plain listing might print for a well-known
 * principal: the numeric `*S-...` form {@link WELL_KNOWN_PRINCIPALS} writes
 * with (language-independent, what `/grant` takes), and the friendly display
 * name Windows resolves that SID to when *reading* an ACL back — both cited
 * against the same well-known-SID table (docs/notes/windows-permissions.md
 * §1). Read-back matching (`Icacls.ts`'s `permissionsSatisfied`) needs both
 * forms because writing and reading render the same SID differently, not
 * because either form alone is wrong.
 *
 * UNVERIFIED: no Windows machine has confirmed a plain listing actually
 * resolves `*S-1-3-4` to "OWNER RIGHTS" rather than leaving a raw SID string
 * on some build/locale — see docs/notes/windows-permissions.md §7. The two
 * real fixtures `Icacls.test.ts` pins against do independently confirm
 * `BUILTIN\Users` is the friendly form actually printed for `S-1-5-32-545`.
 */
export const WELL_KNOWN_PRINCIPAL_ALIASES = {
  owner: [WELL_KNOWN_PRINCIPALS.owner, "OWNER RIGHTS"],
  group: [WELL_KNOWN_PRINCIPALS.group, "BUILTIN\\Users"],
  other: [WELL_KNOWN_PRINCIPALS.other, "Everyone"],
} satisfies Record<"owner" | "group" | "other", readonly string[]>;

/** One principal's grant: a Sid (or `icacls` Sid-string) and its rights. */
export interface WindowsGrant {
  readonly principal: string;
  readonly rights: readonly IcaclsRight[];
}

/**
 * The full translation of a `mode`'s intent into what `icacls` should be
 * told: reset inheritance (always — see below) and grant each class that has
 * any rights at all.
 *
 * A principal computed to have *no* rights is omitted from `grants` rather
 * than given an explicit `(N)`/no-access ACE. Omission and explicit
 * no-access are almost, but not quite, the same thing: an explicit deny wins
 * over any *other* grant the same principal might separately hold (from a
 * different ACE, or from group membership), while an absent ACE only means
 * "nothing here grants this principal anything" — it is silent on whatever
 * else might. For {@link WELL_KNOWN_PRINCIPALS}' three targets that
 * distinction has no practical effect (nothing else in this plan grants
 * `Everyone` or `BUILTIN\Users` anything either, once inheritance is reset),
 * so omission is preferred: it produces a shorter, more legible ACL for the
 * common case of "owner-only" (`0o600`, `0o700`) without changing the
 * outcome.
 */
export interface WindowsAclPlan {
  /** Always true: a `mode` prop states the *entire* intended access, so any
   * inherited ACE broadening it beyond that would make the translation
   * dishonest before the first `/grant` is even issued. */
  readonly resetInheritance: true;
  readonly grants: readonly WindowsGrant[];
}

const PRINCIPAL_CLASSES = [
  [WELL_KNOWN_PRINCIPALS.owner, "owner"],
  [WELL_KNOWN_PRINCIPALS.group, "group"],
  [WELL_KNOWN_PRINCIPALS.other, "other"],
] satisfies ReadonlyArray<readonly [string, "owner" | "group" | "other"]>;

/** Translates a mode's intent into the `icacls` plan that best approximates it. */
export const toWindowsAclPlan = (permissions: FilePermissions): WindowsAclPlan => ({
  resetInheritance: true,
  grants: PRINCIPAL_CLASSES.map(([principal, key]) => ({
    principal,
    rights: rightsForClass(permissions[key]),
  })).filter((grant) => grant.rights.length > 0),
});

/**
 * Renders a plan as the argv `icacls` expects — plain tokens, not a shell
 * string. The caller quotes: `Sh.pwsh(...toIcaclsArgv(path, plan))` alongside
 * `shell: "powershell.exe"`, the same seam every other Windows backend in
 * this repo uses (`packages/system-packages/src/backends/windows/*.ts`).
 *
 * `/inheritance:r` is unconditional and always first: it must run before the
 * grants below it, or the grants would be added on top of whatever was
 * inherited rather than replacing it.
 */
export const toIcaclsArgv = (path: string, plan: WindowsAclPlan): readonly string[] => [
  "icacls",
  path,
  "/inheritance:r",
  ...plan.grants.flatMap((grant) => ["/grant:r", `${grant.principal}:(${grant.rights.join(",")})`]),
];
