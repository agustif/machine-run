import * as Schema from "effect/Schema";

/**
 * Every interactive shell this repo knows how to render dotfile content for.
 *
 * Mirrors `PackageManagerBackend`/`SecretBackend`: one generic seam, one small
 * module per implementation, dispatched by id. Adding a shell means writing
 * `backends/<Name>.ts` and adding a line to `Store.ts` — never a new
 * composition function, and never a per-shell branch inside one.
 */
export const ShellId = Schema.Literals(["zsh", "bash", "fish", "nu", "pwsh"]);

export type ShellId = typeof ShellId.Type;

/**
 * What `Shell.hook` asks a backend to render: run `command` whenever the
 * working directory changes to something matching `pathGlob`.
 *
 * `pathGlob` is a shell-native glob (e.g. `/Users/a/work/*`), not a git
 * `includeIf gitdir:` pattern — a caller converting from the latter does that
 * conversion itself (see `@machine-run/git`'s `toShellGlob`) before calling
 * `Shell.hook`, because the conversion is a git-config concern, not a shell
 * one.
 */
export interface ShellHookProps {
  /** Identifier-safe name, folded into the generated function/hook name. */
  readonly name: string;
  readonly pathGlob: string;
  /** Shell command to run verbatim when `pathGlob` matches. Already quoted by the caller if it carries a value. */
  readonly command: string;
}

/**
 * How a shell's rc file(s) work for `Shell.envVar`/`pathEntry`/`alias`/`hook`.
 *
 * `rcPath` is where those four composition functions write their managed
 * blocks by default. It is deliberately singular even though a shell may read
 * more than one startup file (see `backends/Bash.ts`): every other shell here
 * has exactly one file that is read by *every* interactive session regardless
 * of login status, so `rcPath` names that one file. Bash does not — see
 * `loginRc` below and that backend's module doc comment for why a second rc
 * path is not just `rcPath`'s plural.
 */
export interface ShellBackend {
  readonly id: ShellId;
  /** Comment syntax for `Dotfiles.ManagedBlock`'s marker lines in this shell's rc file. */
  readonly commentPrefix: string;
  /** Home-relative path to the rc file `envVar`/`pathEntry`/`alias`/`hook` manage by default. */
  readonly rcPath: string;
  /** Renders an exported environment variable assignment. */
  readonly renderEnvVar: (name: string, value: string) => string;
  /** Renders prepending `dir` to `PATH`, guarded against duplicate entries where the shell doesn't already dedupe. */
  readonly renderPathEntry: (dir: string) => string;
  /** Renders a shell alias/function equivalent to `alias name=command`. */
  readonly renderAlias: (name: string, command: string) => string;
  /**
   * Renders a named function taking positional arguments — what `alias`
   * cannot express, since an alias is a fixed substitution with no parameter
   * of its own (see `backends/Pwsh.ts`'s `renderAlias`, which already
   * generates a one-off forwarding function to make `alias` work at all on a
   * shell with no native alias-with-arguments form).
   *
   * `body` is source in `props.shell`'s own syntax, exactly like
   * `renderAlias`'s `command` and `renderHook`'s `command` — this package
   * never translates one shell's dialect into another's. Every backend
   * except nu's exposes arguments the same way that shell already does for
   * any function (`$1`/`$2`/`$@` for zsh/bash, `$argv` for fish, `$args` for
   * pwsh) with no signature to declare, so `params` is ignored there. nu's
   * `def` is genuinely different: nu functions are statically parameterised,
   * so there is no implicit "argv" a body can read — `params` names the
   * positional parameters nu's `def` must declare for `body` to reference
   * them at all. Passing `params` for a backend that ignores it is harmless;
   * omitting it for nu produces a valid zero-argument function.
   */
  readonly renderFunction: (name: string, body: string, params?: ReadonlyArray<string>) => string;
  /** Renders a directory-change hook — see {@link ShellHookProps}. */
  readonly renderHook: (props: ShellHookProps) => string;
  /**
   * Set only for a shell whose `rcPath` is not reliably read by a *login*
   * invocation (currently just bash). When set, describes one extra managed
   * block — at `path`, rendered by `render(rcPath)` — that makes a login
   * shell load `rcPath` too.
   *
   * Deliberately not applied automatically by `envVar`/`pathEntry`/`alias`/
   * `hook`: doing so on every call would silently take over a second rc file
   * the caller never asked to manage, and for a machine where that file does
   * not exist yet, creating it changes which file the shell reads on its next
   * login session (see `backends/Bash.ts`). A caller that wants this opts in
   * explicitly via `Shell.ensureLoginShellLoadsRc`.
   */
  readonly loginRc?: {
    readonly path: string;
    readonly render: (rcPath: string) => string;
  };
}
