/**
 * `git-identity` is named after the one thing that was needed on the day —
 * a single git persona composition — rather than the surface it actually
 * belongs to: git configuration in general. That surface is now
 * `@machine-run/git`, which owns `Git.Config` (one global `git config`
 * key/value, diffed against live `git config --global --get` output) and
 * every composition built on it, `gitIdentity` among them.
 *
 * This module is a thin re-export so existing recipes (`examples/example-
 * machine`) keep compiling unchanged. Do not add anything new here — new
 * git functionality belongs in `@machine-run/git`. This package should be
 * removed before 1.0; see `docs/git-notes.md`.
 */
export { type GitPersonaProps, gitIdentity } from "@machine-run/git";
