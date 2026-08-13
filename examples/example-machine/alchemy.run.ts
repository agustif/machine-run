// Example machine recipe demonstrating machine-run's primitives directly —
// no opinionated "roles" layer (that's something you write yourself, suited
// to your own identities; see machines-agusti in this author's own setup
// for a worked example of what that can look like).
import * as AiTools from "@machine-run/ai-tools";
import * as Dotfiles from "@machine-run/dotfiles";
import { gitIdentity } from "@machine-run/git-identity";
import * as MacOsDefaults from "@machine-run/macos-defaults";
import * as Secrets from "@machine-run/secrets";
import { sshHost } from "@machine-run/ssh";
import * as SystemPackages from "@machine-run/system-packages";
import * as Tailscale from "@machine-run/tailscale";
import * as Alchemy from "alchemy";
import * as Command from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const HOME = "/home/you";

export default Alchemy.Stack(
  "example-machine",
  {
    providers: Layer.mergeAll(
      Dotfiles.providers(),
      Command.providers(),
      Secrets.providers(),
      MacOsDefaults.providers(),
      SystemPackages.providers(),
      Tailscale.providers(),
    ),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    // One git identity, scoped to a path glob. Add more `gitIdentity(...)`
    // calls for other personas (personal vs. work), each with its own
    // `pathGlob` — see @machine-run/git-identity's docs comment.
    yield* gitIdentity({
      persona: "personal",
      name: "Your Name",
      email: "you@example.com",
      pathGlob: `${HOME}/**`,
      gitconfigPath: `${HOME}/.gitconfig`,
      personaConfigPath: `${HOME}/.gitconfig-personal`,
    });

    // Which package manager backend to use is picked automatically by OS —
    // see @machine-run/system-packages' detectSystemPackageManager. Each
    // package is its own atomic System.Package resource.
    yield* SystemPackages.packages("brew", ["mise", "ripgrep", "fd"]);

    // Managed block inside a file you don't fully own — never clobbers
    // your existing .zshrc content.
    yield* Dotfiles.ManagedBlock("shell-path", {
      path: `${HOME}/.zshrc`,
      marker: "example",
      content: 'export PATH="$HOME/.local/bin:$PATH"',
    });

    // Captured from this machine's current `defaults read` output in a real
    // recipe — see @machine-run/macos-defaults' README for the workflow.
    yield* MacOsDefaults.MacDefault("dock-autohide", {
      domain: "com.apple.dock",
      key: "autohide",
      type: "bool",
      value: "true",
      restartApp: "Dock",
    });

    // Requires `op signin` and a real 1Password item reference first:
    //
    // yield* Secrets.SecretFile("ssh-key", {
    //   path: `${HOME}/.ssh/id_ed25519`,
    //   opRef: "op://Personal/SSH Key/private key",
    //   mode: 0o600,
    // });

    // Requires reviewing and copying real config/skills content into a
    // vault directory first — see @machine-run/ai-tools' README:
    //
    // yield* AiTools.aiTools({ home: HOME, vaultDir: `${HOME}/vault/ai-tools` });

    // Requires the old unmanaged Host block removed from ~/.ssh/config first:
    //
    // yield* sshHost({
    //   configPath: `${HOME}/.ssh/config`,
    //   name: "example",
    //   hostnames: ["example.com"],
    //   identityFile: `${HOME}/.ssh/id_ed25519`,
    // });

    // Requires a real Tailscale account + an auth key stored in 1Password:
    //
    // yield* Tailscale.TailscaleConnection("tailscale", {
    //   authKeyOpRef: "op://Personal/Tailscale/authkey",
    // });
  }),
);
