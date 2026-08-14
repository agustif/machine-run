// Example machine recipe demonstrating machine-run's primitives directly —
// no opinionated "roles" layer (that's something you write yourself, suited
// to your own identities; see machines-agusti in this author's own setup
// for a worked example of what that can look like).
import * as Dotfiles from "@machine-run/dotfiles";
import { gitIdentity } from "@machine-run/git";
import * as MacOsDefaults from "@machine-run/macos-defaults";
import * as Machine from "@machine-run/machine";
import * as SystemPackages from "@machine-run/system-packages";
import * as Alchemy from "alchemy";
import * as Command from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * `@machine-run/machine`'s `providers()` is every resource package's
 * providers wired together exactly once — see its own doc comment for the
 * full reasoning. Hand-assembling this (as this recipe used to, with a long
 * comment about `Layer.provideMerge` ordering) is exactly the trap that
 * package exists to close: a package's `providers()` simply never appearing
 * in a hand-built `Layer.mergeAll(...)` is a **silent runtime failure**, not
 * a compile error — the first `yield*` of that resource fails at `alchemy
 * plan`/`deploy` time with a bare "service not found," not at `tsc -b` time.
 * The only thing this recipe adds on top is `Command.providers()`, Alchemy's
 * own `Command.Exec`/`Build`/`Dev` escape hatch, which `Machine.providers()`
 * deliberately excludes because none of this repo's own packages use it.
 */
const providers = Layer.mergeAll(Machine.providers(), Command.providers());
// `Alchemy.Stack(name, options, effect)` — the direct three-argument form, and
// the only one that builds a stack.
//
// This used to read `Alchemy.Stack<{}>()(name, options, effect)`, adopted as a
// workaround for a variance problem (`Provider<T>` declaring `of` as a
// property-style function made it invariant in `T`, so no
// `Provider<Machine.File>` was assignable to `Provider<any>`). That workaround
// was the repo's P0 for its entire history: calling `Stack()` with no arguments
// takes its `if (!stackName)` branch, which returns a *cross-stack reference*
// builder — `Output.stackRef(stackName)` — that ignores both `options` and the
// effect. What came back was a `StackRefExpr`, so `evalStack`'s
// `Effect.provide(stack.services)` read `.services` off a lazy property proxy,
// got a `PropExpr`, and `Layer.buildWithMemoMap` called `.build()` on it, which
// returned `undefined`. That `undefined` reached `Effect.map`, and the run loop
// reported `Fiber.runLoop: Not a valid effect: undefined` — a message four
// layers removed from the cause, which is why it read as an upstream defect.
//
// The variance problem it worked around no longer reproduces: this file and
// `examples/complete-machine` both type-check against the direct form.
export default Alchemy.Stack(
  "example-machine",
  {
    providers,
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    // One git identity, scoped to a path glob. Add more `gitIdentity(...)`
    // calls for other personas (personal vs. work).
    //
    // `~/.gitconfig` resolves `includeIf` last-match-wins, so a narrower
    // persona has to be written after a broader one. Alchemy reconciles
    // independent resources concurrently and has no user-facing `dependsOn`,
    // so that ordering comes from one persona's props referencing another's
    // output — see `@machine-run/git`'s docs for the current field to pass.
    yield* gitIdentity({
      persona: "personal",
      name: "Your Name",
      email: "you@example.com",
      pathGlob: "~/**",
      personaConfigPath: "~/.gitconfig-personal",
    });

    // Which package manager backend to use is picked automatically by OS —
    // see @machine-run/system-packages' detectSystemPackageManager. Each
    // package is its own atomic System.Package resource.
    yield* SystemPackages.packages("brew", ["mise", "ripgrep", "fd"]);

    // Managed block inside a file you don't fully own — never clobbers
    // your existing .zshrc content.
    yield* Dotfiles.ManagedBlock("shell-path", {
      path: "~/.zshrc",
      marker: "example",
      content: 'export PATH="$HOME/.local/bin:$PATH"',
    });

    // Captured from this machine's current `defaults read` output in a real
    // recipe — see @machine-run/macos-defaults' README for the workflow.
    // (Only meaningful on macOS — omit this resource entirely on other OSes.)
    yield* MacOsDefaults.MacDefault("dock-autohide", {
      domain: "com.apple.dock",
      key: "autohide",
      value: true,
      restartApp: "Dock",
    });

    // Values are ordinary property-list shapes, so arrays and dictionaries are
    // expressed directly rather than through a scalar flag.
    yield* MacOsDefaults.MacDefault("finder-toolbar", {
      domain: "com.apple.finder",
      key: "NSToolbar Configuration Browser",
      value: { "TB Display Mode": 2, "TB Is Shown": 1 },
      restartApp: "Finder",
    });

    // Deliberately stops here. Secrets, AI tooling, ssh hosts and Tailscale
    // each need something this repo cannot provide for you — an authenticated
    // vault, a reviewed vault directory, an existing `Host` block removed by
    // hand, a real tailnet — so a recipe meant to be *run* should not carry
    // them until you have done that setup.
    //
    // They used to sit here as commented-out prose, which was worse than not
    // having them: commented code is never type-checked, so this block went on
    // naming a package for as long as that package had been deleted without
    // anything failing. Every resource kind now has a real, compiled call in
    // `examples/complete-machine` instead, where `tsc -b` and
    // `packages/machine/test/ExampleCoverage.test.ts` keep it honest. Copy
    // from there.
  }),
);
