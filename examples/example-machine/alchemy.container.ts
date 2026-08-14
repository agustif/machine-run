// Linux-safe recipe used by `scripts/deploy-check.sh` to actually deploy this
// repo, end to end, inside a throwaway container — see docs/deploy-notes.md
// for what that run found.
//
// `alchemy.run.ts` is the general demo and is unapologetically macOS-shaped
// (`MacOS.Default`). None of that runs on Linux: `defaults`/`plutil` do not
// exist there, and `MacOS.Default`'s reconciler has no platform guard, so
// its `apply` would `Effect.die` the moment it tried to shell out to a
// command that is not on `PATH`. Rather than silently skip a resource kind
// and call the run a pass, this is a second, deliberately Linux-appropriate
// recipe covering the primitives that *do* mean something on Linux:
//
//   Machine.File
//   System.Package (apt)
//   Machine.ManagedBlock
//   Machine.Directory
//   Machine.Symlink
//   Machine.Exec
//   Machine.SecretFile (the `env` backend — no CLI, no auth, never a real vault)
//   Machine.Template
//   Machine.LineInFile
//   Machine.Download (from a local HTTP server `entrypoint.sh` starts — no
//                      dependency on the real internet)
//   Git.Config
//   Git.Repo (cloned from a local origin `entrypoint.sh` creates — no
//             dependency on the real internet)
//
// Deliberately excluded, and why:
//   - `MacOS.Default`          — macOS-only, see above.
//   - `Tailscale.Connection`   — needs a real Tailscale account + auth key.
//   - `@machine-run/ai-tools`  — needs a reviewed vault directory this repo
//                                 does not ship.
//   - `@machine-run/ssh`       — same; also mutates `~/.ssh/config`, which
//                                 the harness has no reviewed content for.
//   - `@machine-run/git-identity`/`Shell.*` compositions — compose
//                                 `Machine.File`/`Machine.ManagedBlock`
//                                 already covered above, so add no new kind.
//   - `Shell.Login`            — `chsh` needs real PAM password auth for a
//                                 non-root user changing their own shell;
//                                 verified in a container (exit 1,
//                                 "Authentication failure" with no tty).
//                                 Running as root instead takes a different,
//                                 unrepresentative code path — see
//                                 `Login.ts`'s own doc comment.
//   - `System.Service`         — needs a real systemd user session (D-Bus,
//                                 `loginctl enable-linger`); not present in a
//                                 plain, unprivileged container.
//   - `Runtime.Tool`           — a real mise/asdf/rustup/uv install is slow
//                                 and network-heavy for what this check buys.
//
// `$HOME` here is the container's own throwaway user (see
// `docker/Dockerfile`) — never a real machine's home directory.
import * as Ai from "@machine-run/ai";
import * as Core from "@machine-run/core";
import * as Dotfiles from "@machine-run/dotfiles";
import * as Git from "@machine-run/git";
import * as Secrets from "@machine-run/secrets";
import * as Ssh from "@machine-run/ssh";
import * as SystemSettings from "@machine-run/system-settings";
import * as Runtimes from "@machine-run/runtimes";
import * as Shell from "@machine-run/shell";
import * as SystemPackages from "@machine-run/system-packages";
import * as Alchemy from "alchemy";
import { CommandExecutorLive } from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { homedir } from "node:os";
import { join } from "node:path";

// Hand-assembled rather than `@machine-run/machine`'s aggregate, to keep a
// Linux recipe from dragging in providers it can never use.
//
// The cost of doing it this way is visible right here: `gitIdentity()` is a
// composition, so which providers it needs is not apparent from the call —
// it builds on `Git.Config`, and leaving `Git.providers()` out of this list
// produces a resource with no registered provider. Under `Machine.providers()`
// that cannot happen. Prefer the aggregate unless a recipe has a specific
// reason not to, and when hand-assembling, remember that every composition
// function has transitive provider requirements the call site does not show.
const providers = Layer.mergeAll(
  Ai.providers(),
  Dotfiles.providers(),
  Git.providers(),
  Secrets.providers(),
  Ssh.providers(),
  Runtimes.providers(),
  Shell.providers(),
  SystemPackages.providers(),
  SystemSettings.providers(),
).pipe(Layer.provide(Core.services()), Layer.provide(CommandExecutorLive()));

export default Alchemy.Stack(
  "example-machine-container",
  {
    providers,
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    yield* Dotfiles.File("persona-config", {
      path: "~/.gitconfig-personal",
      content: [
        "[user]",
        "\tname = Container Test",
        "\temail = container-test@example.com",
        "",
      ].join("\n"),
    });

    // `detectSystemPackageManager` would also pick "apt" on this image (a
    // Debian-family container), but composing a stack never runs on the
    // target machine itself, so the manager is named explicitly rather than
    // detected. `cowsay` is small, fast to install, and not part of the base
    // image, so its presence/absence is a real, observable signal.
    yield* SystemPackages.packages("apt", ["cowsay"]);

    yield* Dotfiles.ManagedBlock("shell-path", {
      path: "~/.bashrc",
      marker: "example",
      content: 'export PATH="$HOME/.local/bin:$PATH"',
    });

    yield* Dotfiles.Directory("config-dir", {
      path: "~/.config/machine-run-demo",
      mode: 0o700,
    });

    // `source` must already exist — `Symlink` never fabricates content, by
    // design (see its doc comment). `scripts/deploy-check.sh` creates
    // `~/vault/motd` before the first `alchemy deploy`, standing in for a
    // reviewed, checked-in location a real recipe would point at.
    yield* Dotfiles.Symlink("motd-link", {
      path: "~/.motd",
      source: "~/vault/motd",
    });

    yield* Dotfiles.Exec("marker-exec", {
      command: "touch ~/.exec-marker",
      creates: "~/.exec-marker",
    });

    // The `env` backend needs no CLI and no interactive auth, and — like
    // every `SecretBackend` — never lets the value itself reach Alchemy's
    // state. `scripts/deploy-check.sh` exports `MACHINE_RUN_TEST_SECRET`
    // before running `alchemy deploy`.
    yield* Secrets.SecretFile("demo-secret", {
      path: "~/.config/machine-run-demo/secret",
      source: { _tag: "Env", variable: "MACHINE_RUN_TEST_SECRET" },
    });

    yield* Dotfiles.Template("greeting-template", {
      path: "~/.config/machine-run-demo/greeting.txt",
      template: "Hello, ${name}! Welcome to ${host}.\n",
      variables: { name: "Container Test", host: "deploy-check" },
    });

    yield* Dotfiles.LineInFile("greeting-line", {
      path: "~/.config/machine-run-demo/one-line.conf",
      match: "^GREETING=",
      line: "GREETING=hello-from-line-in-file",
    });

    // Fetched from `entrypoint.sh`'s own local HTTP server, not the real
    // internet — see this file's header comment.
    yield* Dotfiles.Download("download-fixture", {
      url: "http://127.0.0.1:8765/download-fixture.txt",
      path: "~/.config/machine-run-demo/downloaded-fixture.txt",
      checksum: "91dcec70836ee052b90e049275a60d5826bbe6e9712a8b0fe491e1485e30be10",
    });

    yield* Git.Config("git-config-username", {
      key: "user.name",
      values: ["Container Test User"],
    });

    // `remote` is not `~`-expanded by `Git.Repo` itself (only `path` is), so
    // the origin `entrypoint.sh` creates at `~/vault/origin-repo` is resolved
    // to an absolute path here rather than passed as a literal `~/...` string.
    const clone = yield* Git.Repo("demo-repo-clone", {
      path: "~/demo-repo-clone",
      remote: join(homedir(), "vault", "origin-repo"),
      branch: "main",
    });

    // `repo: clone.path` rather than the same path spelled again as a literal.
    // Passing the *output* is what makes Alchemy order these: `Git.Maintenance`
    // cannot register a repository that has not been cloned yet, and with two
    // independent literals the engine reconciled them in whichever order it
    // liked — which failed with `GitMaintenanceRepoNotFound` about half the time.
    // Reusing the dependency edge Alchemy already derives from output references
    // beats sequencing them by hand.
    yield* Git.Maintenance("demo-repo-maintenance", { repo: clone.path });

    // ed25519 rather than rsa: no `bits` to get wrong, and fast enough that a
    // real `ssh-keygen` in the deploy path costs nothing.
    yield* Ssh.Key("demo-ssh-key", {
      path: "~/.ssh/id_demo",
      algorithm: "ed25519",
      comment: "machine-run deploy-check",
    });

    // A real, well-known public key, so this pins the file format rather than a
    // value invented here. Never contacted — `Ssh.KnownHost` only writes the line.
    yield* Ssh.KnownHost("demo-known-host", {
      host: "demo.machine-run.invalid",
      keyType: "ssh-ed25519",
      publicKey: "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
    });

    // The Claude backend writes `~/.claude.json` directly, with no CLI involved,
    // so this exercises the whole AI seam in a container with nothing installed.
    // `org.gnome.desktop.interface clock-format` comes from
    // `gsettings-desktop-schemas`, which the image installs — a real schema key
    // rather than one invented for the test. `entrypoint.sh` runs every alchemy
    // invocation under `dbus-run-session`, without which `gsettings set` exits 0
    // and changes nothing.
    yield* SystemSettings.Setting("demo-clock-format", {
      _tag: "Gsettings",
      schema: "org.gnome.desktop.interface",
      key: "clock-format",
      value: "'24h'",
    });

    // `zsh` is installed by the image, so it is in `/etc/shells` — which
    // `Shell.Login` checks before calling `chsh`. It runs elevated: `chsh` for a
    // non-root user authenticates through PAM, which has nowhere to prompt here.
    yield* Shell.Login("demo-login-shell", { shell: "/bin/zsh" });

    // `flatpak remote-add` registers a URL and downloads nothing, so this is a
    // real repository add at negligible cost. Debian has no PPAs, so Flatpak is
    // the `RepoSpec` arm this image can genuinely exercise.
    yield* SystemPackages.Repo("demo-flatpak-remote", {
      repo: { _tag: "Flatpak", name: "flathub", location: "https://dl.flathub.org/repo/flathub.flatpakrepo" },
    });

    // `jq` rather than a language runtime: mise installs a single small binary,
    // so this exercises the whole `Runtime.Tool` path without a toolchain build.
    yield* Runtimes.RuntimeTool("demo-mise-jq", {
      _tag: "Mise",
      tool: "jq",
      version: "1.7.1",
    });

    yield* Ai.McpServer("demo-mcp-server", {
      tool: "claude",
      name: "deploy-check-server",
      transport: { _tag: "Stdio", command: "npx", args: ["-y", "demo-mcp"] },
    });
  }),
);
