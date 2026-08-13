# Windows permissions: research, design, and a pure prototype

This is the record behind the "Windows properly" item in `docs/TASKS.md` P2,
specifically: `Machine.File`, `Machine.Directory`, `Machine.Download`,
`Machine.SecretFile`, and `Machine.ManagedBlock`'s `directoryMode` all take a
POSIX `mode` prop, and that prop is meaningless on Windows as currently
implemented — 10 of the 16 tests failing on the Windows CI runner trace back
to it (`docs/TASKS.md`'s "Windows" entry has the count). The question this
file answers, with evidence, before any code changes anything: **does Windows
have its own mode-like abstraction this repo should share, or translate to, or
give up and ignore?**

Everything below was checked against a primary source — Microsoft's own
documentation, Node's own docs, libuv's own source, or a real, independently
posted transcript of real command output — not recalled. Where something
could not be verified (because there is no Windows machine to run it on),
that is stated as UNVERIFIED rather than presented as fact, per `AGENTS.md`
§5 and §14.

---

## §1 — Windows' own permission abstraction: DACLs, ACEs, `icacls`

Windows does not have a single number like `mode`. Every securable object
(files, directories, registry keys, ...) carries a **security descriptor**,
and the part that governs "who may do what" is the **DACL** (Discretionary
Access Control List): an ordered list of **ACEs** (Access Control Entries),
each naming a principal (a **SID** — Security Identifier) and a set of rights,
as either an explicit Allow or an explicit Deny.
(Microsoft Learn, ["Access Control: Understanding Windows File And Registry
Permissions"](https://learn.microsoft.com/en-us/archive/msdn-magazine/2008/november/access-control-understanding-windows-file-and-registry-permissions),
John R. Michener, MSDN Magazine, Nov 2008 — archived but written by a
Microsoft security PM and technically unchanged since.)

`icacls` is the current command-line tool for reading and writing a DACL
(`cacls`, its predecessor, is deprecated). Its own reference page
(<https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls>,
fetched in full, quoted verbatim below) documents three tiers of right:

- **Simple rights** (no parentheses needed): `N` (no access), `F` (full),
  `M` (modify), `RX` (read & execute), `R` (read-only), `W` (write-only),
  `D` (delete).
- **Advanced rights** (comma-separated, parenthesised): `DE` (delete),
  `RC` (read control / read permissions), `WDAC` (write DAC / change
  permissions), `WO` (write owner / take ownership), `S` (synchronize),
  `AS`, `MA`, `GR`/`GW`/`GE`/`GA` (generic read/write/execute/all),
  `RD` (read data / list directory), `WD` (write data / add file),
  `AD` (append data / add subdirectory), `REA`/`WEA` (read/write extended
  attributes), `X` (execute/traverse), `DC` (delete child),
  `RA`/`WA` (read/write attributes).
- **Inheritance rights** (parenthesised, directories only): `(I)` inherited
  from the parent, `(OI)` object-inherit (files in this container inherit),
  `(CI)` container-inherit (subdirectories inherit), `(IO)` inherit-only
  (doesn't apply to this object itself, only propagates), `(NP)` don't
  propagate past the immediate children.

`/inheritance:r` disables inheritance on an object and strips its inherited
ACEs (as opposed to `:d`, which disables inheritance but *keeps* a copy of
what was inherited, or `:e`, which re-enables it) — this is the operation
that makes "reset to exactly what `mode` says" possible at all; without it, a
`/grant` is additive on top of whatever a parent directory handed down.
`/setowner` changes the owner. `/grant[:r] Sid:perm` grants (`:r` replaces
prior explicit grants rather than adding to them). `/deny` explicitly denies.
Both accept a numeric SID prefixed with `*` when the friendly name isn't
guaranteed to resolve — the doc's own remark: *"Using special identities...
only works if the system language is set to English... to make this language
independent, use an asterisk followed by the well-known SID."*

### Well-known SIDs approximating POSIX owner/group/other

From Microsoft's own well-known-SID reference
(<https://learn.microsoft.com/en-us/windows/win32/secauthz/well-known-sids>)
and the MSDN Magazine article above:

| SID | Name | POSIX-ish role |
|---|---|---|
| `S-1-3-4` | `OWNER RIGHTS` (Vista+) | **owner** — see below, this is the interesting one |
| `S-1-5-32-545` | `BUILTIN\Users` | closest stand-in for "other trusted accounts on this machine" |
| `S-1-1-0` | `Everyone` / `World` | **other** — genuinely close |
| `S-1-5-18` | `NT AUTHORITY\SYSTEM` | the OS itself; always has access regardless of what's granted, the rough Windows analogue of POSIX root |
| `S-1-5-32-544` | `BUILTIN\Administrators` | local admins; same caveat as SYSTEM |
| `S-1-5-11` | `NT AUTHORITY\Authenticated Users` | anyone who authenticated (excludes anonymous/guest, unlike Everyone) |

**`OWNER RIGHTS` (`S-1-3-4`) is the one genuinely load-bearing find here.**
Introduced in Windows Vista/Server 2008, it is a placeholder SID that an ACE
can name instead of a real user or SID, and the system resolves it at
access-check time to whoever currently owns the object — the same MSDN
Magazine article: *"The presence of the OW owner ACE restriction blocks the
implicit grant of RC/WD to the owner unless these grants are explicitly made
to the owner ACE... This allows mitigation of this security issue"* (the
issue being: previously, `CREATOR OWNER` granted the *creator* permanent
control even after they left the group that originally justified it). Before
Vista, an object's owner implicitly got `RC`+`WDAC` regardless of the DACL;
`OWNER RIGHTS` is what lets an ACL author say "grant *the current owner*,
whoever that is, exactly these rights" without knowing or hard-coding a
username. This is exactly what `Machine.File`'s `mode` needs on Windows: a
way to express "the owner" without this repo ever having to shell out to
`whoami` or track a SID per machine.

---

## §2 — What Node/libuv actually do on Windows (source, not assumption)

**`fs.chmod`.** Node's own docs (`doc/api/fs.md`, fetched from
`raw.githubusercontent.com/nodejs/node/main/doc/api/fs.md`), verbatim:

> Caveats: on Windows only the write permission can be changed, and the
> distinction among the permissions of group, owner, or others is not
> implemented.

That is Node's own claim, and libuv's source confirms exactly how. In
`src/win/fs.c` (`libuv/libuv`, tag `v1.x`, fetched directly), `fs__chmod`
(the Windows backend for `uv_fs_chmod`, which `fs.chmod` calls) is:

```c
static void fs__chmod(uv_fs_t* req) {
  int result = _wchmod(req->file.pathw, req->fs.info.mode);
  ...
}
```

`_wchmod` is the MSVCRT compatibility shim, and `fs__fchmod` (used by
`fs.fchmod`) shows explicitly what it does under the hood — toggles exactly
one Windows file attribute based on whether *any* write bit is present in the
requested mode:

```c
  if (req->fs.info.mode & _S_IWRITE) {
    file_info.FileAttributes &= ~FILE_ATTRIBUTE_READONLY;
  } else {
    file_info.FileAttributes |= FILE_ATTRIBUTE_READONLY;
  }
```

There is no owner/group/other distinction possible here at all — `_S_IWRITE`
is one bit checked once, not three per-class bits, because DOS/CRT `chmod`
never modeled classes to begin with. `chmod(path, 0o477)` (no owner-write,
full group/other) and `chmod(path, 0o600)` (owner-write, nothing else) both
collapse to "clear `FILE_ATTRIBUTE_READONLY`, because *something* in the mode
asked for write" — the two are indistinguishable to this call.

**`fs.stat().mode`.** libuv's `fs__stat_assign_statbuf` (same file,
`src/win/fs.c`) is where the number actually comes from. Its own comment,
left in verbatim by libuv's maintainers, is worth reading whole:

```c
  /* Todo: st_mode should probably always be 0666 for everyone. We might also
   * want to report 0777 if the file is a .exe or a directory.
   *
   * Currently it's based on whether the 'readonly' attribute is set, which
   * makes little sense because the semantics are so different: the 'read-only'
   * flag is just a way for a user to protect against accidental deletion, and
   * serves no security purpose. Windows uses ACLs for that.
   *
   * Also people now use uv_fs_chmod() to take away the writable bit for good
   * reasons. Windows however just makes the file read-only, which makes it
   * impossible to delete the file afterwards, since read-only files can't be
   * deleted.
   *
   * IOW it's all just a clusterfuck and we should think of something that
   * makes slightly more sense.
   *
   * And uv_fs_chmod should probably just fail on windows or be a total no-op.
   * There's nothing sensible it can do anyway.
   */
```

and the code immediately below it:

```c
  if (stat_info.FileAttributes & FILE_ATTRIBUTE_READONLY)
    statbuf->st_mode |= _S_IREAD | (_S_IREAD >> 3) | (_S_IREAD >> 6);
  else
    statbuf->st_mode |= (_S_IREAD | _S_IWRITE) | ((_S_IREAD | _S_IWRITE) >> 3) |
                        ((_S_IREAD | _S_IWRITE) >> 6);
```

`_S_IREAD` is `0400` (octal), `_S_IWRITE` is `0200`. Working through the
bit shifts by hand: a normal (non-read-only) file gets
`0600 | 0060 | 0006 = 0666`, and a read-only file gets `0400 | 0040 | 0004 =
0444` — exactly the two numbers this repo's own `TASKS.md` cites ("Node
reports `0o666` for every file on Windows"), now traced to the exact line
that produces them, by the libuv maintainers' own admission that it "makes
little sense."

**The consequence, stated precisely.** `fs.chmod(path, 0o600)` on Windows
clears the read-only attribute (because `0o600` has a write bit somewhere),
which is a no-op if the file wasn't read-only already, and then
`fs.stat(path).mode` reports `0o666` regardless of what was asked for. A
pinned `mode` of `0o600` can never be observed back as `0o600` — `matches`
would compare `0o600` against `0o666` forever and report drift on every
plan, exactly the bug this file exists to fix.

---

## §3 — Is there a defensible mode → ACL-intent mapping?

Yes, with named, citable caveats. There is no single official Microsoft table
mapping "POSIX octal digit" to "NTFS advanced rights" — POSIX mode is not a
Windows concept, so no such table could exist as an official artifact. What
this section builds is a **defensible construction**, composed entirely from
individually-documented `icacls` advanced rights (the list in §1, fetched
verbatim from Microsoft Learn), not copied from a single authoritative
"conversion table" — because none exists to copy.

The construction (implemented in `packages/core/src/windows/FilePermissions.ts`):

| POSIX bit | Windows advanced rights | Why |
|---|---|---|
| `read` | `RD`, `REA`, `RA`, `RC`, `S` | Read data, read extended attributes, read basic attributes, read the ACL itself, and the bookkeeping "synchronize" right several APIs require to open a handle at all. `RC`+`S` have no POSIX bit of their own — POSIX doesn't distinguish "can read the file's ACL" from "can read the file's content" the way NTFS does — so they ride along with `read` rather than being independently controllable. |
| `write` | `WD`, `AD`, `WEA`, `WA` | Write data, append data, write extended/basic attributes. Deliberately **not** `DE` (delete) — POSIX write on a *file* does not imply the right to delete the file itself (that's governed by the *directory's* write bit on POSIX, via unlink), and granting `DE` here would be broader than what `0o600`'s write bit asks for. |
| `execute` (file) | *(rendered as `X`, but see §4 — this is the one genuinely unmappable case)* | |
| `execute` (directory) | `X` | **Faithful.** POSIX `x` on a directory means "may be traversed to reach children" — Windows' Traverse Folder right (`X`) is exactly that concept, not an approximation. |

Two concrete cases the task asked about directly:

- **`0o600` ("only the owner may read or write")**: translates to one grant —
  `OWNER RIGHTS` gets `RD,REA,RA,RC,S,WD,AD,WEA,WA` — and no ACE at all for
  `BUILTIN\Users` or `Everyone`, after `/inheritance:r` clears anything a
  parent handed down. This is a faithful translation of *intent* — "no
  principal other than the owner has a standing grant" — with the one
  caveat every translation on this platform shares (see §4):
  Administrators/SYSTEM are not erased by this and cannot be, on either
  platform, without special-casing an OS-level bypass this repo does not
  attempt to fight.
- **`0o644`**: owner gets read+write, `BUILTIN\Users` and `Everyone` each get
  read-only (`RD,REA,RA,RC,S`). Faithful.
- **`0o700` for a directory**: owner gets read+write+`X` (traverse) — the
  genuinely-faithful execute case above. Faithful.

**Why not use the simple rights (`F`/`M`/`RX`/`R`/`W`) instead?** They don't
decompose per-bit. The GUI's "Modify" bundle (commonly described, e.g. in
search-engine synthesis of <https://petri.com/ntfs-permissions/> and similar
pages — **not independently confirmed against a single fetchable Microsoft
table**, so treated here as orienting color, not a citation to build the
mapping on) is described as "read & execute, plus write, plus delete" — which
is *broader* than POSIX `rw` (no delete) by definition. Composing the
advanced rights individually, each sourced from icacls's own documented
vocabulary rather than a GUI bundle, is the only way to grant exactly what a
POSIX bit asks for and nothing more.

---

## §4 — What genuinely does NOT map (honesty required here)

- **POSIX "group" has no Windows equivalent on a personal machine.** POSIX
  group membership is a real, per-user, admin-assigned concept (`staff`,
  `wheel`, a project group). Windows' closest analogue, `BUILTIN\Users`, is
  "every local account" — not a configurable subset. Using it for POSIX
  `group` is the least-wrong available choice, not a faithful one, and it
  will be **wrong** for any recipe whose `mode`'s group bits were chosen
  because of a genuine POSIX group (e.g. a shared project directory with
  `chgrp`). There is no fix for this that doesn't involve either standing up
  real Windows groups (out of scope for a personal-machine tool with no
  domain) or accepting the approximation.
- **The execute bit has no meaning for a Windows *file*.** Windows decides
  whether something runs by file extension and shell/PE-loader association,
  not by a permission bit distinct from Read. `FilePermissions.ts` still
  renders `execute` on a file to the `X` advanced right (for symmetry and
  because it costs nothing to grant), but granting or withholding it changes
  **nothing** about whether the file executes — this is stated in the
  module's own doc comment so it cannot be mistaken for a working control.
- **Administrators, SYSTEM, and inherited ACEs from further up the tree are
  not erased by a translation, and cannot honestly be presented as erased.**
  `/inheritance:r` only detaches from *this object's own* parent at the
  moment it runs — a later change to an ancestor's ACL, or a re-inheritance,
  is out of this translation's control. This is analogous to POSIX root
  bypassing file permissions, not a defect unique to this mapping, but
  stating "no one but the owner can read this" without the caveat would be
  the exact "claim more than that would be theatre" mistake `docs/TASKS.md`
  calls out elsewhere in this repo (re: `Machine.EncryptedState`'s threat
  model).
- **Mandatory Integrity Labels are a fourth access-control layer with no
  POSIX analogue at all.** `icacls <path>`'s plain listing interleaves a
  `Mandatory Label\High Mandatory Level:(...)` pseudo-ACE with ordinary DACL
  entries (see the real fixture in §5) — this is SACL integrity-level
  policy, not access control, and nothing in POSIX mode expresses or
  constrains it. The parser built here passes such lines through as
  ordinary-shaped ACEs (same `principal:(flags)` syntax) rather than
  crashing on them, but does not attempt to interpret `NW` ("No Write Up")
  or otherwise treat the entry as meaningful — see `Icacls.ts`.
- **Deny ACEs are indistinguishable from Allow ACEs in `icacls <path>`'s
  plain listing.** Per Microsoft's own documented ACE canonical ordering
  (explicit denies sort first, then explicit allows, then inherited denies,
  then inherited allows — MSDN Magazine article, §1), *position* is the only
  documented signal, and this repo declines to infer allow-vs-deny from
  position alone (see §5 and `Icacls.ts`'s header comment) because doing so
  would be exactly the "plausible flag that looks right" `AGENTS.md` §5 warns
  against for an unverified claim. `icacls /save`'s SDDL output tags
  ace_type explicitly (`A;`/`D;`, confirmed in the MSDN Magazine article's
  own worked examples) and is the correct foundation for anything that needs
  to see denies — noted as follow-up work, not solved here.

---

## §5 — Can an ACL be read back and compared? Real `icacls` output

This is the question that decides whether any of the above is usable for
`observe`/`matches` at all, or whether Windows permissions are a write-only
operation exactly like `chmod` already is.

**Yes — `icacls <path>` prints a stable, parseable format**, and unlike
winget's fixed-width table (`packages/system-packages/src/backends/windows/Winget.ts`),
it is closer to `choco`'s in spirit: one principal per (indented) line,
rights in parentheses, a summary trailer. No Windows machine was available
to capture this repo's own transcript directly (the same limitation
`system-packages-notes.md` documents for `winget`/`choco` before their CI
verification step existed), so the exact byte-for-byte real output below was
sourced from a public transcript instead of invented: a PostgreSQL mailing
list attachment
(<https://www.postgresql.org/message-id/attachment/103457/icacls_output.txt>),
someone's real interactive PowerShell session pasted verbatim while debugging
an unrelated permissions issue. Fetched in full; reproduced here exactly,
with only the `PS C:\WINDOWS\system32> icacls ...` prompt/command-echo lines
removed (a terminal artifact of the interactive session, not part of
`icacls`'s own stdout — a non-interactive `CommandExecutor` invocation would
never produce them):

```
C:\ BUILTIN\Administrators:(OI)(CI)(F)
    NT AUTHORITY\SYSTEM:(OI)(CI)(F)
    BUILTIN\Users:(OI)(CI)(RX)
    NT AUTHORITY\Authenticated Users:(OI)(CI)(IO)(M)
    NT AUTHORITY\Authenticated Users:(AD)
    Mandatory Label\High Mandatory Level:(OI)(NP)(IO)(NW)

Successfully processed 1 files; Failed processing 0 files
```

```
C:\Users\user\AppData\ NT AUTHORITY\SYSTEM:(I)(OI)(CI)(F)
                        BUILTIN\Administrators:(I)(OI)(CI)(F)
                        LOCATION\user:(I)(OI)(CI)(F)

Successfully processed 1 files; Failed processing 0 files
```

Both blocks are committed verbatim as test fixtures:
`packages/core/test/fixtures/icacls-c-drive.txt` and
`icacls-appdata.txt`. Three things this real output settled that an invented
fixture never would have surfaced:

1. **Indentation is dynamic, not fixed-width.** The continuation lines'
   leading whitespace is exactly `len(path) + 1` spaces (the path plus the
   single space that separates it from the first principal on line one) —
   confirmed by counting characters in both blocks above, which have
   different path lengths and correspondingly different indentation. A
   parser cannot assume a fixed column offset the way `Winget.ts` does; it
   must either already know `path` (this repo always does — it is the
   argument the parser's own caller passed to `icacls`) or give up trying to
   separate path from principal on line one, since a path may itself contain
   spaces.
2. **A single principal can appear on more than one ACE line.**
   `NT AUTHORITY\Authenticated Users` appears twice in the first block —
   once with `(OI)(CI)(IO)(M)` (an inherit-only template for children) and
   once bare with `(AD)` (a grant on the object itself). A caller asking
   "what can this principal actually do here" needs the *union* across every
   line naming it, not just the first match — this is exactly what
   `Icacls.ts`'s `grantedRights` does, and it exists because this fixture
   forced the question, not because it was anticipated.
3. **`icacls` interleaves a SACL integrity-label pseudo-ACE with ordinary
   DACL entries**, in the identical `Name:(...)` syntax
   (`Mandatory Label\High Mandatory Level:(OI)(NP)(IO)(NW)`). An invented
   fixture, built only from the documented right-abbreviation list, would
   never have included this — there is no way to predict it from the
   abbreviation table alone. It is the concrete instance of §4's integrity-
   label point, and it is why the parser's rights are typed as bare
   `readonly string[]`, not the closed `IcaclsRight` union `FilePermissions.ts`
   renders: a real ACL can carry tokens this repo never writes, and the
   parser must not crash on, or silently drop, a line it doesn't recognise.

**Provenance honesty, stated plainly**: this is real, unedited `icacls`
output — but it was not captured by this repo's own CI, on this repo's own
Windows runner. `Icacls.test.ts` pins the parser against it; that is
necessary but not sufficient. `IcaclsLive.test.ts` (mirroring
`system-packages/test/windowsLive.test.ts`'s exact pattern) is the seam that
closes the remaining gap, once the CI step added to `verify-windows` in
`.github/workflows/ci.yml` has actually run on a Windows runner and passed —
see §7 for what "verified" means here precisely.

---

## §6 — Design: the options, and why three of them lose

The task named four options. Evaluated in order:

**(c) Ignore `mode` on Windows except `SecretFile`, which errors.** Rejected,
per the owner's explicit steer ("ignore is a bad idea in general if possible
to not ignore") and for a concrete reason beyond deference to that steer:
`SecretFile`'s own doc comment (`packages/secrets/src/SecretFile.ts`)
promises `@default 0o600`, i.e. "nobody but you can read this." Silently
ignoring `mode` everywhere *except* here just relocates the dishonesty from
"we said 0o600 and it wasn't" to "we said we'd tell you when it isn't, but
only for one resource" — every other `mode`-bearing resource still silently
lies about what it wrote. And per §3, ignoring isn't even the *easy* option
here — a defensible mapping exists and costs one pure module to express.

**(d) Reject `mode` on Windows entirely.** Rejected: it throws away the one
case (0o700 on a directory, 0o644, etc.) where a faithful-enough translation
genuinely exists (§3), punishing every recipe that constrains `mode` at all
rather than only the cases that are actually unmappable (the execute-on-file
case, §4). It also does nothing for the underlying problem — a recipe that
never sets `mode` still needs `Machine.Directory`/`Machine.File` to work on
Windows at all, and rejecting the prop doesn't touch that.

**(a) Translate mode → ACL on apply, ACL → an equivalent-intent comparison on
observe, where `matches` asks "no broader than required" rather than
"equals".** Adopted, combined with **(b)**.

**(b) A `FilePermissions` domain type in `core` that both platforms render.**
Adopted. Not a competing option to (a) — the task's own framing anticipates
this: (b) is the *shape* the translation in (a) needs to exist as a value
rather than being re-decided inline at every call site. `FilePermissions.ts`
implements exactly this: `fromPosixMode` builds it from the authoring
notation (a `mode` number, kept exactly as-is — per (b)'s own text, "numeric
mode kept as the authoring notation because it is universally understood");
`toPosixMode` renders the POSIX side (lossless — the two directions decode
and recode the same nine bits); `toWindowsAclPlan`/`toIcaclsArgv` render the
Windows side (lossy, and honestly documented as such in the module's own
header comment, citing exactly which parts don't survive per §4).

**Why (a)'s `matches` question is "no broader", not "equals exactly".** An
exact round-trip is provably impossible (§2: `fs.stat().mode` reports `0o666`
for every writable file, full stop) — but that observation was about
`fs.stat`, not about `icacls`. Once `observe` reads the *ACL* instead of
`stat().mode`, exact equality becomes theoretically possible **except** for
the unavoidable extras §4 names: Administrators/SYSTEM ACEs this repo never
asked for and cannot suppress without real risk (locking out the operator's
own admin account), and any ACE an object legitimately picked up before this
tool touched it. Comparing for exact equality would report those as
permanent, unfixable drift. Comparing "is what's granted a subset of what
`mode` allows" (`Icacls.ts`'s `isNoBroaderThan`) treats those as noise
correctly, at a real and stated cost: it cannot detect a principal that was
granted **fewer** rights than `mode` says — e.g. a `SecretFile` whose owner
somehow lost read access would still read as "matches". This asymmetry is
named explicitly in `isNoBroaderThan`'s own doc comment rather than left
implicit, and closing it (comparing per-class equality against a
reconstructed `FilePermissions` instead of a raw subset check) is left as
follow-up work for whoever wires this into a resource, not resolved here —
see §7.

---

## §7 — What is verified, what is UNVERIFIED, and the prototype's location

**Built, in `packages/core/src/windows/`:**

- `FilePermissions.ts` — `fromPosixMode`/`toPosixMode` (POSIX decomposition,
  lossless), `rightsForClass`/`toWindowsAclPlan`/`toIcaclsArgv` (the mode →
  ACL-intent translation from §3, with every gap from §4 documented at the
  point it applies).
- `Icacls.ts` — `parseIcacls` (the read-back parser from §5),
  `grantedRights` (unions across repeated-principal ACEs), `isNoBroaderThan`
  (the `matches` primitive from §6).

**Verified:**

- Every claim in §1–§4 above, against a primary source cited inline.
- The parser in `Icacls.ts`, against two real (but externally captured)
  `icacls` transcripts — `Icacls.test.ts`.
- The translation in `FilePermissions.ts` is pure POSIX-side arithmetic
  (round-trip tested exhaustively over all 512 modes) plus a documented,
  citable construction on the Windows side — there is nothing to "run" to
  verify a pure rendering function beyond the unit tests already covering it
  (`FilePermissions.test.ts`).

**UNVERIFIED, explicitly:**

- **This parser has never been run against `icacls` output this repo's own
  CI produced.** The two fixtures are real but externally sourced (§5). A CI
  step was added to `.github/workflows/ci.yml`'s `verify-windows` job,
  following the exact `MACHINE_RUN_WINGET_LIST` /
  `packages/system-packages/test/windowsLive.test.ts` pattern already
  established there: it runs `icacls` against a real file on the Windows
  runner, writes the output and the path used to two files, and
  `IcaclsLive.test.ts` (skipped everywhere those env vars are unset) asserts
  the parser against them. **Until that job has actually run on a Windows
  runner and passed, treat the parser as unverified against this repo's own
  environment** — this file existing is not the same claim as it having
  passed. (The same distinction `docs/MAP.md` draws between `✓` and `~`
  everywhere else in this repo.)
- **The `icacls` argv this repo would actually run has never been executed.**
  `toIcaclsArgv` is checked for shape only (`FilePermissions.test.ts`); no
  `/grant:r`/`/inheritance:r` invocation built by this module has been run
  against a real file, on any OS.
- **`isNoBroaderThan`'s "matches" semantics have not been exercised against
  a real Windows object's actual ACL**, only against synthetic sets in
  `Icacls.test.ts`.

**What the follow-up change — wiring this into `Machine.File` /
`Machine.SecretFile` / `Machine.Directory` / `Machine.Download` — would
still need, none of which this change attempts:**

1. A `Platform` service (already tracked, `packages/core/TASKS.md`) so each
   resource's `observe`/`apply` can branch POSIX vs. Windows once, rather
   than re-checking `process.platform` per resource.
2. Each resource's `observe` to run `icacls <path>` (via `Sh.pwsh` +
   `shell: "powershell.exe"`, the same seam `Winget.ts`/`Choco.ts` already
   use) on Windows instead of trusting `fs.stat().mode`, parse it with
   `parseIcacls`, and fold the three managed principals'
   `grantedRights`/`isNoBroaderThan` into whatever shape that resource's
   `matches` already expects.
3. Each resource's `apply` to run `toIcaclsArgv` on Windows instead of (or
   in addition to — POSIX systems still need `fs.chmod`) `fs.chmod`, when
   `props.mode` is set.
4. A resolution for `directoryMode`'s double life
   (`Machine.Directory` vs. the `directoryMode` prop on `File`/
   `ManagedBlock`/`SecretFile` — already flagged as its own P1 item in
   `docs/TASKS.md`) before duplicating the Windows path in two places.
5. A decision on the `isNoBroaderThan` asymmetry named in §6 — whether the
   first Windows-aware `matches` accepts "cannot detect narrower-than-desired
   access" as a documented, temporary gap, or whether it's worth the extra
   work of reconstructing a comparable `FilePermissions` from `observed`
   before wiring anything user-facing on top of it.
6. A real Windows machine or CI runner to actually run any of the above
   against — nothing in this repo has deployed to a real machine yet
   (`AGENTS.md` §14), Windows included.

None of 1–6 is done here, by design: the task was the seam and its
verification, not the resources.
