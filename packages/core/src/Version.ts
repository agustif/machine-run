import * as Match from "effect/Match";
import * as Schema from "effect/Schema";

/**
 * The same underlying idea — "which build of this thing should be here" —
 * has been spelled four different ways across this repo, each arrived at
 * independently while writing one resource, never named as the shared
 * concept it is:
 *
 * - `Runtime.Tool` (`runtimes/src/Tool.ts`) has `version: Schema.String` for
 *   mise/asdf/uv, but `channel: Schema.String` for rustup — discovered only by
 *   running `rustup show`, which calls `stable`/`beta`/`nightly` a "channel",
 *   never a "version", because it genuinely isn't one: it names a moving
 *   target, not a fixed point.
 * - `Machine.Download` (`dotfiles/src/Download.ts`) pins by a required
 *   `checksum: Schema.String` — content-addressed, the strongest kind of
 *   pinning there is, modelled as an unrelated field with no name connecting
 *   it to "version" at all.
 * - `Git.Repo` (`git/src/Repo.ts`) takes an optional `branch: Schema.String`
 *   — a moving ref, only ever used to seed a fresh clone (`apply` never
 *   re-checks it out), which is "re-resolve on every run" wearing a
 *   different word.
 * - `snap` (`system-packages/src/backends/linux/Snap.ts`) pins by channel
 *   (`latest/stable`, `latest/edge`), never a semver — the same channel
 *   concept rustup already needed a separate field for.
 * - `System.Package` (`system-packages/src/Package.ts`) had nothing at all —
 *   `PackageProps` was `{ manager, name }`, so every install meant whatever
 *   the manager considered current *today*. See that module's `PackageProps`
 *   doc comment for how this type closes that gap.
 *
 * `VersionSpec` names the shared *target* concept once — what a recipe is
 * asking for:
 *
 * - **`Exact`** — a fixed version string, matched by equality only:
 *   `apt`'s `pkg=1.2.3`, `npm`'s `pkg@1.2.3`, mise's `node@22.11.0`.
 * - **`AtLeast`** — a floor, not a fixed point: "this version or newer is
 *   fine". This is `Runtime.Tool`'s existing mise/asdf/uv `version` field
 *   (resolved by `versionSatisfies`'s dotted-prefix rule in
 *   `runtimes/src/version.ts`), generalised. `matchesVersionSpec` below
 *   reuses {@link compareVersions} rather than a separate prefix rule — see
 *   its own doc comment for exactly how, and why `runtimes` still carries its
 *   own copy rather than this one.
 * - **`Channel`** — a named moving target: rustup's `stable`/`nightly`,
 *   snap's `stable`/`candidate`/`beta`/`edge`. A channel *name* is what's
 *   compared, never what it currently resolves to.
 * - **`Digest`** — content-addressed: the strongest pin there is, naming the
 *   bytes themselves rather than a label some registry attached to them.
 *   `Machine.Download`'s existing `checksum` is this case in disguise;
 *   `algorithm` is spelled out explicitly (rather than assumed to be SHA-256
 *   the way a single resource's own prop could get away with) because a
 *   shared type has more than one future consumer to be unambiguous for.
 *
 * ## There is no `Latest` case here
 *
 * An earlier draft of this type had one, and it was wrong: "install
 * whatever is newest" is not a *target* — there is no version string, hash
 * or channel name to hold — it is an *instruction about what to do when live
 * state and the request disagree*, which is a different axis entirely and is
 * exactly what {@link UpdatePolicy} is for. Folding "latest" into
 * `VersionSpec` is what let every `System.Package` backend treat every
 * install as "whatever is latest today" *by default*, silently, forever —
 * the reproducibility gap this type exists to close. A recipe that wants
 * "always take whatever is newest" now says so in `updatePolicy`, not by
 * leaving `version` unset and hoping the reader infers the policy from its
 * absence.
 *
 * ## What a backend actually accepts is not this module's job to constrain
 *
 * Not every case has a use in every consumer, and no manager accepts all
 * four: `snap` has no equivalent of `Exact` (a snap is named by channel, and
 * there is no server-side history of "revision 6.4" to request by version
 * string the way a `.deb` archive holds one); `mas` takes no version at all,
 * ever (`mas install` is `<app-id>` and nothing else); pacman's official
 * repos hold exactly one build per package, so `Exact` only ever succeeds
 * when it names the version already current. Each consumer states its own
 * closed subset **in its own type** — see
 * `system-packages/src/Backend.ts`'s `PackageVersionSupport` for the
 * `System.Package` seam's version of this, rather than this module trying to
 * enumerate "every consumer's capability matrix" in one place, which would
 * make a new consumer's capability a change to a file that has nothing to do
 * with it.
 */
export const VersionSpec = Schema.TaggedUnion({
  Exact: { version: Schema.String },
  AtLeast: { version: Schema.String },
  Channel: { name: Schema.String },
  Digest: { algorithm: Schema.Literal("sha256"), hash: Schema.String },
});
export type VersionSpec = typeof VersionSpec.Type;

export type ExactVersion = Extract<VersionSpec, { _tag: "Exact" }>;
export type AtLeastVersion = Extract<VersionSpec, { _tag: "AtLeast" }>;
export type ChannelVersion = Extract<VersionSpec, { _tag: "Channel" }>;
export type DigestVersion = Extract<VersionSpec, { _tag: "Digest" }>;

/**
 * What to do when a {@link VersionSpec} and live state disagree — independent
 * of *what* is wanted (that is `VersionSpec`'s whole job). Two recipes can
 * name the identical `Exact { version: "1.2.3" }` and still want different
 * things to happen the day something upgrades the machine to `1.4.0` behind
 * this tool's back: one wants it forced back to `1.2.3`, the other wants to
 * be left alone now that `1.2.3` was only ever a request about what to
 * install *first*.
 *
 * - `Never` — install once if absent, then never touch it again regardless
 *   of what `version` said or what the live version drifts to afterward.
 *   This was `System.Package`'s original, undocumented, only behaviour — see
 *   `Package.ts`'s doc comment for why it stays the default rather than
 *   being removed: "don't fight whatever else manages this machine" is a
 *   genuinely defensible choice, just one that has to be stated rather than
 *   assumed.
 * - `ToSpec` — actively converge to `version` whenever drift is observed:
 *   reinstall on a mismatch, in either direction. Whether "either direction"
 *   is actually possible is a per-backend fact, not a promise this policy
 *   can keep on its own — see `PackageVersionSupport.canDowngrade`.
 * - `Latest` — always resolve to whatever the manager currently considers
 *   newest, re-resolving on every apply rather than converging to a fixed
 *   target. This is where "latest" belongs now that it is not a
 *   `VersionSpec` case: a recipe that wants perpetual auto-update says so
 *   here, explicitly, rather than that being every recipe's silent fate by
 *   omission.
 */
export const UpdatePolicy = Schema.TaggedUnion({
  Never: {},
  ToSpec: {},
  Latest: {},
});
export type UpdatePolicy = typeof UpdatePolicy.Type;

/**
 * Which side of a version comparison is ahead, so a caller can tell "the
 * live version is older than what's wanted" (an upgrade would close the gap)
 * from "the live version is newer than what's wanted" (only a *downgrade*
 * would) — two situations a plain boolean `matches` cannot distinguish, even
 * though they call for opposite actions and, for several package managers,
 * only one of the two is actually possible (see
 * `system-packages/src/Backend.ts`'s `PackageVersionSupport.canDowngrade`).
 *
 * `Unknown` is a real outcome, not a fallback swallowed into `Equal`: two
 * version strings that aren't both dotted-numeric (a channel name, a commit
 * hash, a manager-specific build tag) have no ordering this function is
 * willing to guess at.
 */
export const VersionDrift = Schema.Literals(["Behind", "Ahead", "Equal", "Unknown"]);
export type VersionDrift = typeof VersionDrift.Type;

const DOTTED = /^\d+([.-]\d+)*$/;

/**
 * Orders two version strings from `observed`'s point of view: `"Behind"`
 * when `observed` is older than `desired` (closing the gap is an upgrade),
 * `"Ahead"` when `observed` is newer (closing the gap needs a downgrade),
 * `"Equal"` when they're the same version.
 *
 * Deliberately not semver, and deliberately not a full dpkg/RPM version
 * comparator either: no `^`/`~`/`>=`, no pre-release or build-metadata
 * ordering, no alphanumeric epoch/revision rules — just numeric components
 * split on `.` *and* `-`, with missing trailing components treated as `0`.
 * The `-` split matters for exactly the strings package managers actually
 * hand back: pacman/apt/dnf's own `<version>-<release>` convention
 * (`"2.3.2-1"`) is not dotted-only, but every component in it still is a
 * plain integer — this compares those correctly without attempting a real
 * `dpkg --compare-versions` (which additionally orders letters, `~`, and a
 * separate epoch field, none of which this function claims to get right).
 * A version carrying anything this loose a rule can't parse as all-numeric
 * (an RPM's `.fc44` distro tag, a go module's `v` prefix, a channel name)
 * returns `"Unknown"` rather than guessing — this is narrower than
 * `versionSatisfies`'s prefix rule in `packages/runtimes/src/version.ts`,
 * which is intentionally asymmetric in a different way — `"22"` satisfies
 * `"22.11.0"` but `"22.11.0"` does not satisfy `"22"`. That function answers
 * "does the shorter string's precision match the longer one"; this one
 * answers "which one is numerically bigger, full stop" — needed here to
 * choose between an upgrade and a downgrade rather than to decide whether
 * either is even necessary.
 */
export const compareVersions = (observed: string, desired: string): VersionDrift => {
  if (observed === desired) return "Equal";
  if (!DOTTED.test(observed) || !DOTTED.test(desired)) return "Unknown";

  const a = observed.split(/[.-]/).map(Number);
  const b = desired.split(/[.-]/).map(Number);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x < y) return "Behind";
    if (x > y) return "Ahead";
  }
  return "Equal";
};

/**
 * Whether `observed` (a concrete version/channel-name/hash string a backend
 * actually reported) satisfies `spec` (what a recipe asked for).
 *
 * `Exact` and `Digest` are plain equality; `Channel` compares the channel
 * *name*, never what it currently resolves to. `AtLeast` reuses
 * {@link compareVersions} rather than a separate prefix rule: an `AtLeast`
 * request is satisfied when `observed` is `"Equal"` to or `"Ahead"` of
 * `spec.version`, and refuses to guess for anything `compareVersions` itself
 * calls `"Unknown"`.
 *
 * This is shared, manager-agnostic comparison logic. It does not replace
 * `versionSatisfies` in `packages/runtimes/src/version.ts` — that function's
 * prefix rule ("22" satisfies "22.11.0") answers a genuinely different
 * question than `AtLeast` here does ("22.11.0" is at least "20.0.0"), and
 * `Runtime.Tool` is out of scope for this change regardless (see
 * `Package.ts`'s migration notes for what moving it over would need).
 */
export const matchesVersionSpec = (spec: VersionSpec, observed: string): boolean =>
  Match.value(spec).pipe(
    Match.tagsExhaustive({
      Exact: (s) => observed === s.version,
      Digest: (s) => observed === s.hash,
      Channel: (s) => observed === s.name,
      AtLeast: (s) =>
        Match.value(compareVersions(observed, s.version)).pipe(
          Match.when("Equal", () => true),
          Match.when("Ahead", () => true),
          Match.orElse(() => false),
        ),
    }),
  );
