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
// `Alchemy.Stack(name, ...)` constrains its requirement parameter to
// `StackServices | ProviderServices`, and `ProviderServices` contains
// `Provider<any>`. `Provider<T>` declares `of` as a property-style function,
// so under `strictFunctionTypes` it is invariant in `T` and no
// `Provider<Machine.File>` is ever assignable to `Provider<any>` — which makes
// that overload unusable for any recipe built on a custom resource. The
// curried `Stack<Self>()` form leaves the requirement parameter unconstrained
// and is otherwise identical.
export default Alchemy.Stack<{}>()(
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
      gitconfigPath: "~/.gitconfig",
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

    // Requires `op signin` and a real 1Password item reference first:
    //
    // import * as Secrets from "@machine-run/secrets";
    // yield* Secrets.SecretFile("ssh-key", {
    //   path: "~/.ssh/id_ed25519",
    //   source: "1password",
    //   ref: "op://Personal/SSH Key/private key",
    //   mode: 0o600,
    // });

    // Requires reviewing and copying real config/skills content into a
    // vault directory first — see @machine-run/ai-tools' README:
    //
    // import * as AiTools from "@machine-run/ai-tools";
    // yield* AiTools.aiTools({ home: "~", vaultDir: "~/machine-run/vault/ai-tools" });

    // Requires the old unmanaged Host block removed from ~/.ssh/config first:
    //
    // import { sshHost } from "@machine-run/ssh";
    // yield* sshHost({
    //   configPath: "~/.ssh/config",
    //   name: "example",
    //   hostnames: ["example.com"],
    //   identityFile: "~/.ssh/id_ed25519",
    // });

    // Requires a real Tailscale account + an auth key stored in 1Password:
    //
    // import * as Tailscale from "@machine-run/tailscale";
    // yield* Tailscale.TailscaleConnection("tailscale", {
    //   authKeyRef: "op://Personal/Tailscale/authkey",
    // });
  }),
);
