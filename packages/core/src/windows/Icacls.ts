import * as Data from "effect/Data";
import * as Result from "effect/Result";

/**
 * Parses `icacls <path>`'s plain-listing output — the read side of the seam
 * `FilePermissions.ts` writes. Without this, `observe` on Windows can report
 * *that* something is there but never *what access it actually grants*, which
 * is the same "drift can never be detected" failure the POSIX `mode` bug
 * already has, just moved one layer down.
 *
 * ## Verification status — read before trusting this
 *
 * The parser is checked against two real fixtures
 * (`test/fixtures/icacls-c-drive.txt`, `test/fixtures/icacls-appdata.txt`),
 * both byte-for-byte real `icacls` output captured on a real Windows machine
 * and posted publicly (see docs/notes/windows-permissions.md §5 for exact
 * provenance and the URL). That is real output, but not output this repo's
 * own CI produced — the difference matters, per `AGENTS.md` §5's "verify,
 * don't recall": a second machine's Windows build, PowerShell version, or
 * locale could format this differently in some way the two fixtures don't
 * exercise. `IcaclsLive.test.ts` is the seam that closes that gap: it runs
 * against output CI captured moments earlier on the Windows runner, and is
 * skipped everywhere else because there is nothing to read. Until that job
 * has actually run and passed, treat this parser as **UNVERIFIED against
 * this repo's own Windows runner**, not merely "verified" — the same
 * distinction `docs/MAP.md` draws for every other backend here.
 *
 * ## What this parser cannot see
 *
 * `icacls <path>`'s plain listing renders an explicit Deny ACE with the exact
 * same `Name:(rights)` shape as a Grant — nothing in the format marks which
 * one it is, beyond canonical ordering (denies sort first). This parser does
 * not attempt to infer ace-type from position, because position is a
 * convention `icacls` documents about *its own output*, not a distinct field
 * — inferring from it would be exactly the "plausible flag that looks right"
 * AGENTS.md §5 warns against. A future `observe` built on this parser must
 * either treat every ACE as an allow (correct for anything this repo's own
 * `apply` ever writes, since it only ever grants) or move to `icacls /save`,
 * whose SDDL output tags ace_type explicitly (`A;`/`D;` — see the notes doc).
 * This module deliberately does neither yet; it only parses what `icacls
 * <path>` prints.
 */

/**
 * Raised when `icacls`'s stdout does not have the shape this parser expects
 * for a single-path invocation — the summary line is missing, `path` isn't
 * the literal prefix of the first ACE line, or a line inside the block isn't
 * `<principal>:(<group>)(<group>)...`.
 *
 * Every one of these is "the format changed under us" rather than "there is
 * no permission information" — collapsing it to an empty result would be the
 * same mistake `FilePathUnreadable` exists to avoid in `dotfiles/File.ts`.
 */
export class IcaclsParseError extends Data.TaggedError("IcaclsParseError")<{
  path: string;
  reason: string;
}> {
  override get message() {
    return `Could not parse \`icacls\` output for "${this.path}": ${this.reason}`;
  }
}

/** The well-known inheritance flags `icacls` prints inside an ACE's parens. */
const INHERITANCE_FLAGS = new Set(["I", "OI", "CI", "IO", "NP"]);

/**
 * One access control entry as `icacls` printed it: a principal name (which
 * may itself contain spaces and backslashes, e.g. `NT AUTHORITY\Authenticated
 * Users`) and the tokens found across every `(...)` group on its line.
 *
 * `rights` is deliberately typed as `readonly string[]`, not the closed
 * {@link IcaclsRight} union `FilePermissions.ts` renders — a real file's ACL
 * can carry tokens this repo never writes (simple rights like `F`, a
 * Mandatory-Label integrity entry's `NW`, a SID this repo doesn't recognise).
 * Narrowing the type here would mean silently dropping or crashing on
 * whatever real Windows systems actually have on them, which is precisely
 * the failure mode AGENTS.md §11 rules out. A caller that wants to compare
 * against `FilePermissions`' rights does the narrowing itself, deliberately,
 * where the "I don't recognise this token" case is visible.
 */
export interface IcaclsAce {
  readonly principal: string;
  readonly inherited: boolean;
  readonly inheritanceFlags: readonly string[];
  readonly rights: readonly string[];
}

/** Every ACE `icacls <path>` printed for one path, in the order printed. */
export interface IcaclsListing {
  readonly path: string;
  readonly aces: readonly IcaclsAce[];
}

const SUMMARY_LINE = /^Successfully processed (\d+) files?; Failed processing (\d+) files?\.?$/;

/** One `(...)` group's contents, comma-split into tokens, e.g. `"GR,GE"` → `["GR", "GE"]`. */
const tokensIn = (group: string): readonly string[] =>
  group
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

/**
 * Splits one ACE line's tail (everything after the principal's own
 * trailing colon) into its token stream, then partitions that stream into
 * inheritance flags and everything else.
 */
const parseAceLine = (line: string): Result.Result<IcaclsAce, string> => {
  const match = /^(.+?):((?:\([^()]*\))+)$/.exec(line.trim());
  if (match === null) return Result.fail(`line does not look like "<principal>:(<rights>)": ${line}`);
  const [, principal, groupsBlob] = match;
  if (principal === undefined || groupsBlob === undefined) {
    return Result.fail(`line does not look like "<principal>:(<rights>)": ${line}`);
  }
  const groups = [...groupsBlob.matchAll(/\(([^()]*)\)/g)].flatMap((groupMatch) =>
    tokensIn(groupMatch[1] ?? ""),
  );
  const inheritanceFlags = groups.filter((token) => INHERITANCE_FLAGS.has(token));
  const rights = groups.filter((token) => !INHERITANCE_FLAGS.has(token));
  return Result.succeed({
    principal: principal.trim(),
    inherited: inheritanceFlags.includes("I"),
    inheritanceFlags,
    rights,
  });
};

/**
 * Parses the stdout of `icacls <path>` for exactly that one `path` — this
 * repo never invokes `icacls` over more than one target at a time (per
 * `AGENTS.md` §2, one resource never owns a list), so multi-path output
 * (`icacls *`, `icacls dir\*`) is out of scope and this parser does not
 * attempt to recognise it.
 *
 * `path` must be passed in rather than inferred from the output, because
 * `icacls` echoes the argument it was given verbatim as the first line's
 * prefix, and a path may itself contain spaces — there is no way to
 * distinguish "where the path ends" from "where the principal name begins"
 * by looking at whitespace alone. The caller always already knows `path`: it
 * is the same string used to build the command.
 */
export const parseIcacls = (stdout: string, path: string): Result.Result<IcaclsListing, IcaclsParseError> => {
  const lines = stdout.split(/\r?\n/);
  const summaryIndex = lines.findIndex((line) => SUMMARY_LINE.test(line.trim()));
  if (summaryIndex === -1) {
    return Result.fail(
      new IcaclsParseError({ path, reason: "no \"Successfully processed\" summary line found" }),
    );
  }

  const summaryMatch = SUMMARY_LINE.exec(lines[summaryIndex]?.trim() ?? "");
  const failed = Number(summaryMatch?.[2] ?? "0");
  if (failed > 0) {
    return Result.fail(
      new IcaclsParseError({
        path,
        reason: `icacls itself reported ${failed} failed file(s) — its listing for "${path}" cannot be trusted`,
      }),
    );
  }

  const aceLines = lines.slice(0, summaryIndex).filter((line) => line.trim().length > 0);
  const [firstLine, ...restLines] = aceLines;
  if (firstLine === undefined) {
    return Result.fail(new IcaclsParseError({ path, reason: "no ACE lines before the summary line" }));
  }
  if (!firstLine.startsWith(`${path} `)) {
    return Result.fail(
      new IcaclsParseError({ path, reason: `first line does not start with "${path} ": ${firstLine}` }),
    );
  }

  const fragments = [firstLine.slice(path.length + 1), ...restLines];
  const aces: IcaclsAce[] = [];
  for (const fragment of fragments) {
    const parsed = parseAceLine(fragment);
    if (Result.isFailure(parsed)) return Result.fail(new IcaclsParseError({ path, reason: parsed.failure }));
    aces.push(parsed.success);
  }

  return Result.succeed({ path, aces });
};

/**
 * The rights a principal was granted, unioned across every ACE naming it —
 * `icacls` genuinely does print more than one ACE for the same principal
 * (see the real fixture: `BUILTIN\Users` appears once with `(RX)` and again
 * with `(OI)(CI)(IO)(GR,GE)`, one non-inherited ACE and one inherit-only
 * template for children). A caller asking "what can this principal actually
 * do to this object itself" wants the union, not just the first match.
 */
export const grantedRights = (listing: IcaclsListing, principal: string): ReadonlySet<string> =>
  new Set(
    listing.aces
      .filter((ace) => ace.principal === principal)
      .flatMap((ace) => ace.rights),
  );

/**
 * `matches`'s Windows-specific question, per the design in
 * docs/notes/windows-permissions.md §6: is what a principal was actually
 * granted **no broader** than what `desired` allows, rather than "does it
 * equal `desired` exactly". Exact equality is unreachable — an object
 * adopted from outside this tool, or one Administrators/SYSTEM still hold
 * ACEs on (see `FilePermissions.ts`'s header comment), will always carry
 * rights `toWindowsAclPlan` never asked for. Asking only "no broader" means
 * those unavoidable, unmanaged extras never register as drift, while a
 * principal gaining a right `desired` withheld — the actual security-relevant
 * case, e.g. `Everyone` gaining `WD` on a file meant to be owner-only — still
 * does.
 *
 * The asymmetry this accepts, stated plainly rather than left implicit: a
 * principal granted *fewer* rights than `desired` allows also reads as
 * "matches" here, so this cannot by itself detect a `SecretFile` that has
 * become unreadable by its own owner. That is a real gap, not an oversight —
 * closing it means reconstructing a comparable `FilePermissions` from
 * `observed` and comparing per-class equality instead, which is follow-up
 * work for whoever wires this into a resource's `matches`, not a decision
 * this pure comparison can make unilaterally.
 */
export const isNoBroaderThan = (
  granted: ReadonlySet<string>,
  allowed: readonly string[],
): boolean => {
  const allowedSet = new Set(allowed);
  return [...granted].every((right) => allowedSet.has(right));
};
