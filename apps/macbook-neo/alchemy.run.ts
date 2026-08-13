import * as AiTools from "@machine-run/ai-tools";
import * as Dotfiles from "@machine-run/dotfiles";
import { brewBundle } from "@machine-run/homebrew";
import * as MacOsDefaults from "@machine-run/macos-defaults";
import * as Roles from "@machine-run/roles";
import * as Secrets from "@machine-run/secrets";
import { sshHost } from "@machine-run/ssh";
import * as Tailscale from "@machine-run/tailscale";
import * as Toolchains from "@machine-run/toolchains";
import * as Alchemy from "alchemy";
import * as Command from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const HOME = "/Users/a";
const GENERATED_DIR = `${HOME}/machine-run/apps/macbook-neo/.generated/homebrew`;
const VAULT_DIR = `${HOME}/machine-run/vault/ai-tools`;

export default Alchemy.Stack(
  "machine-neo",
  {
    providers: Layer.mergeAll(
      Dotfiles.providers(),
      Command.providers(),
      Secrets.providers(),
      Toolchains.providers(),
      MacOsDefaults.providers(),
      Tailscale.providers(),
    ),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    yield* Roles.personalDev({ home: HOME });

    yield* Roles.workDev({
      home: HOME,
      email: "agusti@obvious.ai",
      pathGlob: `${HOME}/code/flatfiles/**`,
      ghAccount: "agustiobvious",
    });

    // Seeded from the exact Brewfile captured from this machine
    // (`brew bundle dump --describe`) so the first apply is a no-op except
    // for installing the 1password-cli cask this Mac doesn't have yet.
    yield* brewBundle(
      "machine-neo",
      {
        taps: [
          "can1357/tap",
          "lucasgelfond/zerobrew",
          "muxy-app/tap",
          "sidequery/tap",
          "thdxg/tap",
          "vaayne/tap",
        ],
        brews: [
          "apktool",
          "aria2",
          "bat",
          "coreutils",
          "doppler",
          "fd",
          "flux",
          "fresh-editor",
          "gh",
          "jadx",
          "lf",
          "libtorrent-rasterbar",
          "mise",
          "mole",
          "mpv",
          "node",
          "openjdk@17",
          "pkgconf",
          "ripgrep",
          "spaceship",
          "tmux",
          "transmission-cli",
          "usbutils",
          "wireshark",
          "zplug",
          "can1357/tap/omp",
          "lucasgelfond/zerobrew/zerobrew",
          // Added by machine-run: required for Secrets.SecretFile below.
          "1password-cli",
        ],
        casks: [
          "android-commandlinetools",
          "sidequery/tap/ghostree",
          "ghostty",
          "thdxg/tap/macterm",
          "markedit",
          "vaayne/tap/mori",
          "muxy-app/tap/muxy",
          "orbstack",
          "slack",
          // Added by machine-run: required for the Tailscale example below.
          "tailscale",
        ],
      },
      GENERATED_DIR,
    );

    // Seeded from the cargo/npm globals already on this machine (captured
    // alongside the Brewfile). Additive only — see Cargo.ts/Npm.ts.
    yield* Toolchains.CargoPackages("machine-neo-cargo", {
      packages: ["cargo-bloat", "cargo-fuzz", "flamegraph"],
    });
    yield* Toolchains.NpmGlobalPackages("machine-neo-npm", {
      packages: [
        "@opencode-ai/cli",
        "playwriter",
        "pnpm",
        "prime-agent",
        "shuvcode",
        "typescript-language-server",
        "typescript",
      ],
    });

    // Captured directly from `defaults read` on this machine — every value
    // below is what's already set, so this is a true no-op on first apply.
    yield* MacOsDefaults.MacDefault("dock-autohide", {
      domain: "com.apple.dock",
      key: "autohide",
      type: "bool",
      value: "false",
      restartApp: "Dock",
    });
    yield* MacOsDefaults.MacDefault("dock-tilesize", {
      domain: "com.apple.dock",
      key: "tilesize",
      type: "int",
      value: "35",
      restartApp: "Dock",
    });
    yield* MacOsDefaults.MacDefault("trackpad-tap-to-click", {
      domain: "com.apple.AppleMultitouchTrackpad",
      key: "Clicking",
      type: "bool",
      value: "false",
    });

    // Once `op signin` has been run manually and a real 1Password item
    // reference exists, uncomment and fill in the ref:
    //
    // yield* Secrets.SecretFile("github-personal-ssh-key", {
    //   path: `${HOME}/.ssh/id_ed25519_personal`,
    //   opRef: "op://Personal/GitHub SSH Key/private key",
    //   mode: 0o600,
    // });

    // Once you've reviewed and copied specific files/skills into
    // vault/ai-tools (see its README) — nothing here does anything until
    // real content exists at those source paths:
    //
    // yield* AiTools.aiTools({ home: HOME, vaultDir: VAULT_DIR });

    // ~/.ssh/config already has this Host block hand-written (found by
    // machine-run's initial exploration). Remove that unmarked stanza first
    // — otherwise this would coexist as a harmless but redundant duplicate
    // (ssh_config is first-match-wins, so the old one would still win) —
    // then uncomment:
    //
    // yield* sshHost({
    //   configPath: `${HOME}/.ssh/config`,
    //   name: "exe",
    //   hostnames: ["exe.dev", "*.exe.xyz"],
    //   identityFile: `${HOME}/.ssh/exe_dev`,
    //   extra: { IdentitiesOnly: "yes" },
    // });

    // Requires a real Tailscale account + an auth key stored in 1Password:
    //
    // yield* Tailscale.TailscaleConnection("machine-neo-tailscale", {
    //   authKeyOpRef: "op://Personal/Tailscale/authkey",
    //   hostname: "machine-neo",
    // });
  }),
);
