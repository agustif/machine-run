import type { ShellBackend } from "../Backend.ts";
import { quoteNu } from "../quote.ts";

const toIdent = (name: string) => name.replace(/[^a-zA-Z0-9_]/g, "_");

/**
 * nu reads `config.nu` for every session, login or not — like zsh and fish.
 * Verified in a container (nu 0.114.1): `$nu.env-path` and `$nu.config-path`
 * resolve to `~/.config/nushell/env.nu` and `~/.config/nushell/config.nu`
 * respectively, and nu's own convention is to put environment variables in
 * `env.nu` and everything else in `config.nu`. This backend deliberately
 * targets `config.nu` alone for all four renderers rather than following
 * that split: nu does not enforce it (an `$env.NAME = ...` assignment works
 * identically in either file, confirmed in a container), and one rc path
 * keeps this backend's shape uniform with every other shell here.
 *
 * `renderAlias`'s `command` is nu source, not a quoted string — unlike every
 * other backend. `alias name = <pipeline>` (confirmed: `alias ll = ls -la`
 * registers as an `alias`-type command) takes an actual nu expression on the
 * right of `=`, so a caller targeting nu must already speak nu syntax there;
 * there is no way to make an arbitrary POSIX/fish command string portable to
 * it.
 */
export const NuBackend: ShellBackend = {
  id: "nu",
  commentPrefix: "#",
  rcPath: "~/.config/nushell/config.nu",

  /** `$env.NAME = r#'value'#` — a raw string, so the value can never be reinterpreted as nu code. */
  renderEnvVar: (name, value) => `$env.${name} = ${quoteNu(value)}`,

  /**
   * nu represents `PATH` as a list, not a colon-joined string, so `prepend`
   * plus `uniq` is the native dedupe — verified in a container: prepending an
   * already-present directory left it as the single, first entry.
   */
  renderPathEntry: (dir) => `$env.PATH = ($env.PATH | prepend ${quoteNu(dir)} | uniq)`,

  renderAlias: (name, command) => `alias ${name} = ${command}`,

  /**
   * nu's `def` is genuinely different from every other backend's function
   * form: nu functions are statically parameterised, so there is no implicit
   * "argv" a body can read the way `$1`/`$argv`/`$args` work elsewhere in
   * this package. `params` names the positional parameters `def` declares —
   * untyped (`[a, b]`, not `[a: string, b: string]`), so a caller passing any
   * value nu can bind doesn't need this package to guess a type. Omitting
   * `params` (or passing an empty array) declares a zero-argument function,
   * which is valid nu and simply means `body` takes no parameters. Verified
   * in a container (nu 0.114.1): `def greet [a, b] { $"hello ($a) and ($b)" }`
   * called as `greet Alice Bob` read back `hello Alice and Bob`, and a
   * variadic `def greetall [...rest] { ... }` (a caller can put `...name` in
   * `params` for this, since it's inserted into the signature verbatim)
   * called with three arguments joined all three back out of `rest` — see
   * `docs/shell-notes.md`.
   */
  renderFunction: (name, body, params = []) =>
    [`def ${name} [${params.join(", ")}] {`, ...body.split("\n").map((line) => `    ${line}`), "}"].join(
      "\n",
    ),

  /**
   * ## The mechanism, and what's verified vs. not
   *
   * nu's directory-change hook is `$env.config.hooks.env_change.PWD`, a list
   * of closures each called with `(before, after)`. Verified in a container:
   * registering a closure this way and reading back
   * `$env.config.hooks.env_change.PWD | length` confirmed it was stored —
   * this is nu's real, documented hook API, not a guess.
   *
   * What's **not** verified is the hook actually firing: nu only runs
   * `env_change` hooks from its interactive line-editor (reedline) loop.
   * Every non-interactive invocation tried (`nu -c "..."`, a script file,
   * piped stdin with `-i`) either ran the `cd`s without firing the hook at
   * all, or nu refused outright ("launched as a REPL, but STDIN is not a
   * TTY"). Getting a real TTY into a container proved unreliable in this
   * environment (a `pty`-backed harness and an `expect` script both hung or
   * crashed rather than completing) — see `docs/shell-notes.md`. So the
   * *registration* is confirmed correct; the *firing* rests on nu's own
   * documented behaviour rather than this package's own observation, which
   * is a real gap, not a papered-over one.
   *
   * ## Compose, don't replace
   *
   * The obvious-looking `$env.config = ($env.config | upsert
   * hooks.env_change.PWD [{|before, after| ...}])` **overwrites** the whole
   * `PWD` hooks list. Two independent `Shell.hook` calls targeting nu in one
   * recipe render two separate `ManagedBlock` regions in the same
   * `config.nu`, sourced top to bottom — with that form, the second region
   * to load would silently discard the first's hook. This renders the
   * read-current-then-append form instead
   * (`$env.config.hooks.env_change.PWD? | default [] | append {...}`, using
   * nu's `?` optional-field access so a config that has never set this key
   * doesn't error), verified in a container to leave both hooks registered
   * (`| length` read back `2` after two such assignments run in sequence).
   *
   * ## The glob is a documented subset
   *
   * `pathGlob` is expected to be `<dir>/*` — the only shape
   * `@machine-run/git`'s `toShellGlob` (and every other caller in this repo)
   * produces. This renders it as a `str starts-with` prefix check rather than
   * attempting general glob matching, because nu has no built-in "match this
   * string against a glob pattern" operator for anything other than real
   * filesystem paths (`glob`/`into glob`, confirmed via `help commands` in a
   * container, both operate on the filesystem, not on an arbitrary string). A
   * `pathGlob` containing a `*` anywhere but a trailing `/*` is not supported
   * by this backend and renders as a literal (incorrect) prefix rather than
   * failing loudly — a caller relying on richer glob shapes for nu needs a
   * different mechanism than this one.
   */
  renderHook: (props) => {
    const fnName = `_machine_run_${toIdent(props.name)}`;
    const prefix = props.pathGlob.endsWith("/*") ? props.pathGlob.slice(0, -2) : props.pathGlob;
    return [
      `# ${fnName}`,
      "$env.config = ($env.config | upsert hooks.env_change.PWD (",
      "    ($env.config.hooks.env_change.PWD? | default []) | append {|before, after|",
      `        if ($after | str starts-with ${quoteNu(prefix)}) {`,
      `            ${props.command}`,
      "        }",
      "    }",
      "))",
    ].join("\n");
  },
};
