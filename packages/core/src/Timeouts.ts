import type * as Duration from "effect/Duration";

/**
 * How long a command of each kind is allowed to take.
 *
 * Named by the work rather than by the number, because the number is the part
 * that has no meaning at a call site: `timeout: "10 minutes"` appeared 28 times
 * and said nothing about why ten. These say what is being waited for, so the
 * ceiling can be argued about in one place and a new backend picks the right one
 * by naming its own behaviour.
 *
 * Not a single `defaultTimeout`: a `git config --get` and a rustup toolchain
 * build differ by two orders of magnitude, and one ceiling covering both is
 * either useless or dangerous. `ExecutionContext.defaultTimeout` still exists as
 * the floor for a command that names none at all — an unbounded command can hang
 * a deploy, which is worse than a wrong ceiling.
 *
 * `satisfies Duration.Input` rather than an annotation: it checks each value
 * against what `timeout` actually accepts while leaving the literal type intact
 * (annotating them `string` widens them out of `Duration.Input`), so a typo like
 * `"10 minute"` is a compile error here instead of a runtime surprise.
 */
export const Timeouts = {
  /** A local one-shot with no network and no compilation: `ssh-keygen`, a stat. */
  quickCommand: "30 seconds",
  /** One round trip to a service that should answer immediately. */
  networkQuery: "1 minute",
  /** Starting, stopping or enabling a service, including its own readiness wait. */
  serviceControl: "2 minutes",
  /** A language package manager resolving and installing: npm, gem, pipx, uv. */
  languagePackage: "5 minutes",
  /** A system package manager: brew, apt, dnf, snap, winget, choco. */
  systemPackage: "10 minutes",
  /** Refreshing a package index — metadata only, no package content. */
  indexRefresh: "5 minutes",
  /** A toolchain that may build from source: rustup, mise, asdf. */
  toolchain: "15 minutes",
} satisfies Record<string, Duration.Input>;

export type TimeoutKind = keyof typeof Timeouts;

