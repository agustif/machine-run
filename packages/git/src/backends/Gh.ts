import type { CredentialHelperBackend } from "../Backend.ts";

/**
 * The GitHub CLI's own credential helper, `gh auth git-credential`.
 *
 * The `!` prefix is what tells git this is a shell command rather than a
 * helper *name* to resolve on `PATH` (`man git-config`'s `credential.helper`:
 * "may also be...if preceded by !, shell commands").
 *
 * Verified in `docker run --rm ubuntu:24.04` (`gh` installed from its own apt
 * repo, `cli.github.com/packages`, onto a clean container — git 2.43.0,
 * `gh version 2.97.0`), without ever authenticating:
 *
 * - `git config --global credential.helper "!gh auth git-credential"` then
 *   `git config --global --get-all credential.helper` round-trips the exact
 *   string back, confirming git's config parser accepts the `!`-shell-command
 *   form for this value.
 * - `GIT_TRACE=1` on `git credential fill` shows git actually dispatching to
 *   it: `run_command: 'gh auth git-credential get'`. That command exits `0`
 *   with empty output (this repo's own `gh auth status` on the same
 *   container confirms "You are not logged into any GitHub hosts") — git then
 *   falls through to its own interactive username/password prompt, which
 *   fails on `could not read Username ...: No such device or address` only
 *   because the container has no controlling tty, not because the helper
 *   invocation was wrong.
 *
 * `gh` must already be authenticated (`gh auth status`) for the helper to
 * return anything useful — machine-run never automates signing in to
 * anything, the same non-negotiable the `secrets` package's backends follow
 * for their own CLIs.
 */
export const GhBackend: CredentialHelperBackend = {
  id: "gh",
  values: ["!gh auth git-credential"],
};
