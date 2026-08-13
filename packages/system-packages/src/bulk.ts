import * as Effect from "effect/Effect";
import { Package, type PackageManagerId } from "./Package.ts";
import { Repo, type RepoManagerId } from "./Repo.ts";

/** Logical IDs need to be filesystem-safe — the real prop values are untouched. */
const toId = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "-");

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
