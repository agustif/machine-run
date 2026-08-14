import type { CredentialHelperBackend } from "../Backend.ts";

/**
 * The GitHub CLI's own credential helper, `gh auth git-credential`.
 *
 * Verified present on this machine (`gh version 2.97.0`). The `!` prefix is
 * what tells git this is a shell command rather than a helper *name* to
 * resolve on `PATH` (`man git-config`'s `credential.helper`: "may also be...
 * if preceded by !, shell commands").
 *
 * `gh` must already be authenticated (`gh auth status`) — machine-run never
 * automates signing in to anything, the same non-negotiable the `secrets`
 * package's backends follow for their own CLIs.
 */
export const GhBackend: CredentialHelperBackend = {
  id: "gh",
  values: ["!gh auth git-credential"],
};
