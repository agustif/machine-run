# `@machine-run/runtimes`

Reconciles one language/toolchain version — via mise, asdf, rustup, or uv —
tracking whether it's installed and whether it's the _active_ one separately,
because a version can be installed but not selected, or selected globally but
shadowed inside one project directory.

## What it exports

| Export                         | What it's for                                             |
| ------------------------------ | --------------------------------------------------------- |
| `RuntimeTool` (`Runtime.Tool`) | One tool version for one manager, installed and/or active |
| `providers()`                  | This package's `Layer`                                    |

`RuntimeToolProps` is a tagged union — `Mise { tool, version }`,
`Asdf { tool, version }`, `Rustup { channel }`, `Uv { version }` — so a
combination that was never legal (e.g. `rustup` with a `tool` field; rustup
only ever manages `"rust"`) is a compile error rather than a runtime
`RuntimeToolMismatch`. `scope` (`Global` or `Directory { path }`) says where
the version is activated: machine-wide, or pinned to one project.

## Example

From `examples/complete-machine/recipes/runtimes.ts`:

```ts
import * as Runtimes from "@machine-run/runtimes";

// A global default. `version` is a request, satisfied by any matching 22.x.
yield * Runtimes.RuntimeTool("node-global", { _tag: "Mise", tool: "node", version: "22" });

// Pinned inside one directory.
yield *
  Runtimes.RuntimeTool("node-project", {
    _tag: "Mise",
    tool: "node",
    version: "20.11.0",
    scope: { _tag: "Directory", path: "~/code/legacy-service" },
  });

// Installed but deliberately not activated.
yield *
  Runtimes.RuntimeTool("python-available", {
    _tag: "Mise",
    tool: "python",
    version: "3.12",
    active: false,
  });

// rustup takes a channel, its own vocabulary — not a `tool` name.
yield * Runtimes.RuntimeTool("rust-stable", { _tag: "Rustup", channel: "stable" });
```

## Verification status

All four backends (`mise`, `asdf`, `rustup`, `uv`) are `✓` per
[docs/MAP.md](../../docs/MAP.md) §4 — run directly, not just read from
`--help`. Verification found a real, non-obvious fact only running the tool
surfaced: `asdf current` prints its answer to stdout **and exits non-zero**;
treating a non-zero exit as failure would have discarded a real answer. See
[docs/notes/runtime-notes.md](../../docs/notes/runtime-notes.md) for exactly
what each backend's verification covered.

Narrower gaps remain: `asdf` has only been verified in an `ubuntu:24.04`
container, not on macOS or native Linux; `rustup show` has never been
exercised with no toolchain active at all (every check ran against an install
with a default already set); and mise/uv/rustup have only been checked on
macOS, not Linux or Windows (asdf itself has no native Windows support).

## What it deliberately does not do

- **No cross-manager tool-name mapping.** `tool` is always spelled in the
  manager's own namespace (`"node"` for mise, `"nodejs"` for asdf) —
  deliberately not normalised here; see [TASKS.md](./TASKS.md).
- **No manifest resource** (`Mise.Toml`, `Asdf.ToolVersions`) — this package
  models one atomic tool/version, not a whole checked-in manifest file. See
  `docs/V1-PLAN.md` §3 for why the atomic and manifest layers are meant to
  coexist rather than one replacing the other.
- **No caching across resources naming the same tool/scope** — each shells out
  independently; not yet shown to matter in practice.
- **No `unapply`.**

See [TASKS.md](./TASKS.md) for the rest, including the cross-compiled rustup
toolchain gap.
