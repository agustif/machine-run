import * as Dotfiles from "@machine-run/dotfiles";
import * as Effect from "effect/Effect";

/**
 * Every resource in `@machine-run/dotfiles`: the six ways this repo writes to
 * a filesystem.
 *
 * The distinction that matters is ownership. `File` owns a whole file and will
 * rewrite it; `ManagedBlock` owns a fenced region inside a file somebody else
 * also edits. Reaching for `File` on `~/.zshrc` is how you delete a
 * hand-written shell config, so the two are never interchangeable.
 */
export const dotfiles = Effect.gen(function* () {
  // A directory stated on its own, rather than as a side effect of writing a
  // file into it. Worth doing when the mode matters: `File`'s
  // `directoryMode` only applies to parents it has to create.
  yield* Dotfiles.Directory("config-dir", {
    path: "~/.config/complete-machine",
    mode: 0o755,
  });

  // A file this recipe owns outright. Rewritten whenever `content` drifts.
  yield* Dotfiles.File("editorconfig", {
    path: "~/.config/complete-machine/editorconfig",
    content: ["root = true", "", "[*]", "indent_style = space", "indent_size = 2", ""].join("\n"),
    mode: 0o644,
  });

  // A fenced region inside a file with other owners. The marker is what makes
  // the region findable on the next run, so it has to stay stable — changing
  // a marker orphans the old block instead of updating it.
  yield* Dotfiles.ManagedBlock("path-block", {
    path: "~/.zshrc",
    marker: "complete-machine:path",
    content: 'export PATH="$HOME/.local/bin:$PATH"',
    position: "append",
  });

  // A symlink, for content that lives in a vault directory under version
  // control and should not be copied to two places.
  yield* Dotfiles.Symlink("vault-link", {
    path: "~/.config/complete-machine/vault",
    source: "~/machine-run/vault/complete-machine",
  });

  // A fetched artifact, pinned by content hash. The checksum is not optional:
  // without it there is no way to tell a corrupted download from a correct
  // one, and `observe` would have nothing to compare against.
  yield* Dotfiles.Download("shellcheck-notice", {
    url: "https://raw.githubusercontent.com/koalaman/shellcheck/master/LICENSE",
    path: "~/.config/complete-machine/shellcheck-LICENSE",
    // Replace with the real hash before running: `curl -sL <url> | shasum -a 256`.
    checksum: "0000000000000000000000000000000000000000000000000000000000000000",
    mode: 0o644,
  });

  // An escape hatch for state no resource models yet. `unless` is what keeps
  // it idempotent — without a guard, `Exec` would run on every single apply,
  // which makes the whole plan dishonest.
  yield* Dotfiles.Exec("rebuild-completions", {
    command: "rm -f ~/.zcompdump && autoload -Uz compinit && compinit",
    unless: "test ! -f ~/.zcompdump",
    cwd: "~",
  });
});
