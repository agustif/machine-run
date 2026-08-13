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
//
// Deliberately excluded, and why:
//   - `MacOS.Default`          — macOS-only, see above.
//   - `Tailscale.Connection`   — needs a real Tailscale account + auth key.
//   - `@machine-run/ai-tools`  — needs a reviewed vault directory this repo
//                                 does not ship.
//   - `@machine-run/ssh`       — same; also mutates `~/.ssh/config`, which
//                                 the harness has no reviewed content for.
//   - `@machine-run/git-identity`/`@machine-run/git` — composes
//                                 `Machine.File`/`Machine.ManagedBlock`
//                                 already covered directly below, and (as of
//                                 this being written) pulls in
//                                 `@machine-run/shell`, a package still being
//                                 written concurrently by another agent — see
//                                 docs/deploy-notes.md. Using its resources
//                                 directly, rather than through that
//                                 composition, keeps this recipe's dependency
//                                 graph small and stable.
//
// `$HOME` here is the container's own throwaway user (see
// `docker/Dockerfile`) — never a real machine's home directory.
import * as Core from "@machine-run/core";
import * as Dotfiles from "@machine-run/dotfiles";
import * as Git from "@machine-run/git";
import * as Secrets from "@machine-run/secrets";
import * as SystemPackages from "@machine-run/system-packages";
import * as Alchemy from "alchemy";
import { CommandExecutorLive } from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
  Dotfiles.providers(),
  Git.providers(),
  Secrets.providers(),
  SystemPackages.providers(),
).pipe(Layer.provideMerge(Core.services()), Layer.provide(CommandExecutorLive()));

export default Alchemy.Stack<{}>()(
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
      source: "env",
      ref: "MACHINE_RUN_TEST_SECRET",
    });
  }),
);
