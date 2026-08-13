import * as Runtimes from "@machine-run/runtimes";
import * as Effect from "effect/Effect";

/**
 * `Runtime.Tool` across mise, asdf, rustup and uv.
 *
 * Installed and active are tracked separately, because they are separately
 * wrong: a version can be installed but not selected, or selected globally but
 * shadowed inside a directory. `active: false` states "have it available",
 * which is the honest description of a toolchain kept around for one project.
 */
export const runtimes = Effect.gen(function* () {
  // A global default. `version` is a request, not an exact pin — `"22"` is
  // satisfied by any 22.x already installed.
  yield* Runtimes.RuntimeTool("node-global", {
    manager: "mise",
    tool: "node",
    version: "22",
  });

  // Pinned inside one directory, which is where a project's version belongs.
  yield* Runtimes.RuntimeTool("node-project", {
    manager: "mise",
    tool: "node",
    version: "20.11.0",
    scope: { _tag: "Directory", path: "~/code/legacy-service" },
  });

  // Installed but deliberately not activated.
  yield* Runtimes.RuntimeTool("python-available", {
    manager: "mise",
    tool: "python",
    version: "3.12",
    active: false,
  });

  // asdf names things in its own namespace: node is `nodejs` here.
  yield* Runtimes.RuntimeTool("ruby-asdf", {
    manager: "asdf",
    tool: "ruby",
    version: "3.3",
  });

  // rustup and uv each manage exactly one fixed toolchain, so `tool` has to
  // name that toolchain — anything else is a `RuntimeToolMismatch`, caught
  // rather than silently installing the wrong thing. `version` is a channel.
  yield* Runtimes.RuntimeTool("rust-stable", {
    manager: "rustup",
    tool: "rust",
    version: "stable",
  });
});
