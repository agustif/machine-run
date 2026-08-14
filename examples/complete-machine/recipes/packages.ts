import * as SystemPackages from "@machine-run/system-packages";
import * as Effect from "effect/Effect";

/**
 * `System.Repo` and `System.Package`.
 *
 * Each package is its own resource rather than an entry in a manifest, so one
 * package failing to install does not take the rest of the plan with it, and
 * drift is reported per package. `packages()` is sugar over that — it returns
 * one `System.Package` per name, it is not a bulk-install call.
 *
 * A repository has to exist before a package from it can resolve, and Alchemy
 * reconciles independent resources concurrently with no user-facing
 * `dependsOn`. The edge comes from referencing the repo's own output in the
 * package's props, which is what `after` is for on the resources that support
 * it; where a backend cannot express that, install the tap in a prior stack.
 */
export const packages = Effect.gen(function* () {
  // A third-party tap. `manager` is explicit here rather than detected,
  // because a repo's addressing scheme is manager-specific: a `ppa:` only
  // means something to apt.
  yield* SystemPackages.Repo("homebrew-tap", {
    repo: { _tag: "Brew", tap: "homebrew/cask-fonts" },
  });

  // One package, stated on its own, so its `version`/drift is visible.
  yield* SystemPackages.Package("ripgrep", {
    manager: "brew",
    name: "ripgrep",
  });

  // The common case: a list of packages from one manager. Every entry becomes
  // an independent `System.Package`.
  yield* SystemPackages.packages("brew", ["fd", "jq", "mise"]);
});
