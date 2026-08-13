import * as Effect from "effect/Effect";
import * as Hash from "effect/Hash";

/**
 * A short, stable, non-cryptographic digest of a string.
 *
 * Effect's `Hash.string` is synchronous, which this needs: logical ids are
 * built inline while constructing each resource, not from inside an effect.
 * It only has to separate two raw names that sanitise to the same string —
 * within one recipe, a set of at most dozens — so collision resistance
 * against an adversary is not a requirement. Base36 keeps it short and
 * filesystem-safe.
 */
const shortHash = (input: string): string =>
  (Hash.string(input) >>> 0).toString(36);
import { Package, type PackageManagerId } from "./Package.ts";
import { Repo, type RepoManagerId } from "./Repo.ts";

/**
 * Logical IDs need to be filesystem-safe — the real prop values are
 * untouched.
 *
 * Sanitisation is lossy: `foo/bar` and `foo-bar` both sanitize to the same
 * `foo-bar`, so two *different* declared package/repo names could collide
 * onto the same alchemy logical ID. That's not a cosmetic problem — alchemy
 * keys persisted state by logical ID, so the second registration silently
 * clobbers the first one's state row (`stack.resources[fqn]` is a plain
 * object keyed by id); nothing errors, one of the two packages just quietly
 * stops being reconciled.
 *
 * Appending a short hash of the *raw* name whenever sanitisation actually
 * changed something keeps genuinely-different names distinct, while leaving
 * already-safe names (the overwhelmingly common case — most package names
 * are already `[a-zA-Z0-9._-]`) untouched, so existing recipes' ids (and
 * their state history) don't churn on upgrade. The hash is a pure function
 * of the input string, so it's stable across runs/machines, unlike e.g. a
 * counter would be.
 */
export const toId = (value: string): string => {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "-");
  return sanitized === value ? sanitized : `${sanitized}-${shortHash(value)}`;
};

/**
 * Sugar over N individual {@link Package} resources — NOT a bundle
 * resource. Each name still becomes its own atomic, independently-diffed
 * `System.Package` instance; this just saves writing the loop at every
 * call site.
 */
export const packages = (manager: PackageManagerId, names: string[]) =>
  Effect.gen(function* () {
    for (const name of names) {
      yield* Package(`${manager}-${toId(name)}`, { manager, name });
    }
  });

export const repos = (manager: RepoManagerId, values: string[]) =>
  Effect.gen(function* () {
    for (const repo of values) {
      yield* Repo(`${manager}-repo-${toId(repo)}`, { manager, repo });
    }
  });
