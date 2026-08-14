import * as Git from "@machine-run/git";
import * as Effect from "effect/Effect";

/**
 * `Git.Config`, `Git.Repo`, and the compositions built on top of them.
 *
 * `Git.Config` is the primitive — one key, its ordered values. Everything else
 * here is a composition that writes one or more of those plus a file, which is
 * why they are plain functions rather than resources: there is no state to
 * reconcile beyond what the resources they call already reconcile.
 */
export const git = Effect.gen(function* () {
  // The primitive, used directly. `values` is a list because a handful of git
  // keys legitimately hold several, in order.
  yield* Git.Config("git-default-branch", {
    key: "init.defaultBranch",
    values: ["main"],
  });

  // `type: "bool"` canonicalises through git's own boolean table on both
  // sides of the comparison, so a config already holding `on` does not read
  // as drift against a desired `true`.
  yield* Git.Config("git-autocrlf", {
    key: "core.autocrlf",
    values: ["false"],
    type: "bool",
  });

  // An identity scoped to a path glob. `~/.gitconfig` resolves `includeIf`
  // last-match-wins, so a narrower persona must be written after a broader
  // one; `after` is what forces that order.
  yield* Git.gitIdentity({
    persona: "personal",
    name: "Your Name",
    email: "you@example.com",
    pathGlob: "~/**",
    personaConfigPath: "~/.gitconfig-personal",
  });

  // A clone. `branch` applies only to a fresh clone: `apply` never runs
  // `checkout`, so an existing repository's current branch is left exactly
  // where its owner left it.
  yield* Git.Repo("dotfiles-repo", {
    path: "~/code/dotfiles",
    remote: "https://github.com/example/dotfiles.git",
    branch: "main",
  });

  yield* Git.gitIgnore("global-ignore", {
    path: "~/.config/git/ignore",
    patterns: [".DS_Store", "node_modules/", "*.log"],
  });

  yield* Git.gitAttributes("global-attributes", {
    path: "~/.config/git/attributes",
    lines: ["*.lockb binary diff=lockb", "*.md text eol=lf"],
  });

  yield* Git.gitAlias("alias-lg", {
    name: "lg",
    command: "log --oneline --graph --decorate",
  });

  // Ordered: git tries each helper in turn, so `gh` last means the keychain
  // answers first and only an unknown host reaches a network call.
  yield* Git.gitCredentialHelper("credentials", {
    helpers: ["osxkeychain", "gh"],
  });

  yield* Git.gitSigning("signing", {
    signingKey: "~/.ssh/id_ed25519.pub",
    commitGpgSign: true,
    allowedSignersPath: "~/.ssh/allowed_signers",
    allowedSigners: [
      {
        principals: "you@example.com",
        publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyReplaceMe",
      },
    ],
  });

  // A shared hooks directory wired in through `core.hooksPath`, so the hooks
  // are managed in one place instead of copied into every clone.
  yield* Git.gitHooksPath("hooks", {
    path: "~/.config/git/hooks",
    hooks: {
      "pre-commit": "#!/bin/sh\nexec git diff --cached --check\n",
    },
  });

  // Background maintenance for one repository. `unapply` deliberately runs
  // `git maintenance unregister --force` rather than `git maintenance stop`:
  // `stop` is machine-wide and tears down the shared schedule for *every*
  // registered repository, so undoing this one resource would silence others.
  yield* Git.Maintenance("dotfiles-maintenance", {
    repo: "~/code/dotfiles",
  });
});
