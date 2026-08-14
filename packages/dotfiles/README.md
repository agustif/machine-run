# `@machine-run/dotfiles`

The file-shaped primitives every other resource package composes on: files,
fenced regions inside files, symlinks, directories, downloads, an escape-hatch
command, rendered templates, and single lines. If a resource in this repo
touches a filesystem path, it is either one of these or built out of them.

## What it exports

| Resource               | Reconciles                                                                   |
| ---------------------- | ---------------------------------------------------------------------------- |
| `Machine.File`         | a file this recipe owns outright — rewritten whenever `content` drifts       |
| `Machine.ManagedBlock` | a fenced, marker-delimited region inside a file with other owners            |
| `Machine.Symlink`      | a symlink and its target                                                     |
| `Machine.Directory`    | a directory and its mode                                                     |
| `Machine.Download`     | a fetched artifact, pinned by a required SHA-256 checksum                    |
| `Machine.Exec`         | an escape hatch for state nothing else models, guarded by `unless`/`creates` |
| `Machine.Template`     | a file rendered from one non-recursive `${name}` substitution pass           |
| `Machine.LineInFile`   | one line inside a file, identified by a `match` regex rather than a marker   |

See [../../docs/MAP.md](../../docs/MAP.md) §3 for how these fit the other 15
resource kinds.

## The one distinction that matters: ownership

`Machine.File` owns a whole file and rewrites it entirely. `Machine.ManagedBlock`
owns only the region between its own BEGIN/END markers and leaves the rest of
the file — including anything a person hand-wrote — untouched. Reaching for
`File` on `~/.zshrc` is how a recipe deletes a hand-written shell config; the
two are never interchangeable. `Machine.LineInFile` is narrower still: no
marker comments at all, just a `match` regex identifying one line. It refuses
when `match` hits more than once (there is no safe "first match wins"
default), and requires `line` itself to satisfy `match` — otherwise a later
plan could never find the line it wrote and would insert a duplicate on every
apply. Reach for `ManagedBlock` instead once ownership spans more than one
line, or a collision with the same regex is plausible.

## Example

From
[`examples/complete-machine/recipes/dotfiles.ts`](../../examples/complete-machine/recipes/dotfiles.ts):

```ts
import * as Dotfiles from "@machine-run/dotfiles";

// A fenced region inside a file with other owners. The marker is what makes
// the region findable on the next run, so it has to stay stable.
yield *
  Dotfiles.ManagedBlock("path-block", {
    path: "~/.zshrc",
    marker: "complete-machine:path",
    content: 'export PATH="$HOME/.local/bin:$PATH"',
    position: "append",
  });

// A fetched artifact, pinned by content hash — the checksum is not optional:
// without it there is no way to tell a corrupted download from a correct one.
yield *
  Dotfiles.Download("shellcheck-notice", {
    url: "https://raw.githubusercontent.com/koalaman/shellcheck/master/LICENSE",
    path: "~/.config/complete-machine/shellcheck-LICENSE",
    checksum: "0000000000000000000000000000000000000000000000000000000000000000",
    mode: 0o644,
  });
```

The full recipe exercises all eight resources; copy from there rather than
this excerpt.

## Verification status

These resources run on plain filesystem calls (`effect/FileSystem`), not a
pluggable per-OS backend — there is no backend seam to verify per-target the
way `system-packages` or `secrets` have. Reconciler logic is unit-tested
directly against real temporary directories (`test/*.test.ts`), including
`Machine.Template`'s missing-placeholder guard and `Machine.LineInFile`'s
ambiguous-match guards, each verified to actually fail their test when
temporarily disabled. What is **not** covered: `Symlink`'s dangling-link and
path-normalisation cases, and `File`/`ManagedBlock`'s reconciler-level drift
paths — see [TASKS.md](./TASKS.md). Like every resource in this repo, none of
these have been run by the real Alchemy engine — see
[../../docs/MAP.md](../../docs/MAP.md).

## What it deliberately does not do

- **Never fabricates content.** `Machine.Symlink` refuses to create a link
  unless its `source` already exists — nothing here invents a target. Reading
  `apply`'s refusal as a bug and working around it defeats the reason it's
  there.
- **`Machine.Directory` never deletes or replaces what's in its way.** A file
  already occupying the path is left alone and reported as an error, not
  swapped out for an empty directory.
- **`Machine.Exec` refuses to run unconditionally.** Without `unless` or
  `creates`, there is no way to tell whether the command already ran, so it
  raises rather than silently becoming "run this shell line on every apply" —
  the one thing a reconciler is not supposed to be. State that explicitly with
  `unless: "false"` if that's genuinely what's wanted.
- **No directory-mode reconciliation across resources yet.** `File`,
  `ManagedBlock`, and `secrets`' `SecretFile` each create parent directories
  themselves via their own `directoryMode` prop; now that `Machine.Directory`
  exists as its own resource, having two ways to say "this directory should
  have this mode" is open, unresolved duplication — see [TASKS.md](./TASKS.md).

See [TASKS.md](./TASKS.md) for the rest of the backlog.
