import * as Dotfiles from "@machine-run/dotfiles";
import * as Effect from "effect/Effect";
import type { ShellId } from "./Backend.ts";
import { shellBackend } from "./Store.ts";

/**
 * Composition functions over {@link Dotfiles.ManagedBlock} — like
 * `@machine-run/ssh`'s `sshHost` — not new `Resource` types. Each renders one
 * shell-appropriate line (or block) via the `ShellId`'s backend and lets
 * `ManagedBlock` own the actual file read-modify-write, drift detection and
 * `FileLock` serialisation.
 *
 * Every function here takes an Alchemy resource `id` as its first argument,
 * exactly like `Dotfiles.File`/`Dotfiles.ManagedBlock` themselves — the
 * caller picks a stable id, the same way `gitIdentity` picks
 * `gitconfig-${persona}` for each persona's resources.
 */

interface WithShellTarget {
  readonly shell: ShellId;
  /** Overrides the backend's default rc path. `~` is expanded by `Dotfiles.ManagedBlock`. */
  readonly rcPath?: string;
  /** Forces this block after another's `hash` — see {@link Dotfiles.ManagedBlockProps.after}. */
  readonly after?: string;
}

const targetOf = (props: WithShellTarget) => {
  const backend = shellBackend(props.shell);
  return { backend, path: props.rcPath ?? backend.rcPath };
};

export interface EnvVarProps extends WithShellTarget {
  readonly name: string;
  readonly value: string;
}

/** One exported environment variable, rendered for `props.shell`'s syntax. */
export const envVar = (id: string, props: EnvVarProps) => {
  const { backend, path } = targetOf(props);
  return Dotfiles.ManagedBlock(id, {
    path,
    marker: `shell-env:${props.name}`,
    commentPrefix: backend.commentPrefix,
    content: backend.renderEnvVar(props.name, props.value),
    ...(props.after !== undefined ? { after: props.after } : {}),
  });
};

export interface PathEntryProps extends WithShellTarget {
  /** Directory to add to `PATH`. Not expanded — pass an already-absolute path. */
  readonly dir: string;
}

/** One `PATH` entry, deduplicated by whichever mechanism `props.shell`'s backend uses natively. */
export const pathEntry = (id: string, props: PathEntryProps) => {
  const { backend, path } = targetOf(props);
  return Dotfiles.ManagedBlock(id, {
    path,
    marker: `shell-path:${props.dir}`,
    commentPrefix: backend.commentPrefix,
    content: backend.renderPathEntry(props.dir),
    ...(props.after !== undefined ? { after: props.after } : {}),
  });
};

export interface AliasProps extends WithShellTarget {
  readonly name: string;
  /**
   * The command the alias runs, in whatever syntax `props.shell` expects for
   * this position — a plain command string for zsh/bash/fish, a full nu
   * pipeline/expression for nu (see `backends/Nu.ts`). Not portable across
   * shells as a single string.
   */
  readonly command: string;
}

/** One alias (or fish/nu's nearest equivalent — see each backend's doc comment). */
export const alias = (id: string, props: AliasProps) => {
  const { backend, path } = targetOf(props);
  return Dotfiles.ManagedBlock(id, {
    path,
    marker: `shell-alias:${props.name}`,
    commentPrefix: backend.commentPrefix,
    content: backend.renderAlias(props.name, props.command),
    ...(props.after !== undefined ? { after: props.after } : {}),
  });
};

export interface HookProps extends WithShellTarget {
  /** Identifier-safe name, folded into the generated function/hook name — must be stable across runs. */
  readonly name: string;
  /** Shell-native glob (e.g. `/Users/a/work/*`) matched against the working directory. */
  readonly pathGlob: string;
  /**
   * Command run verbatim when `pathGlob` matches, in `props.shell`'s own
   * syntax — see {@link ShellHookProps.command}. A caller needing this to
   * work identically across several shells (as `@machine-run/git`'s
   * `gitIdentity` does for its `gh auth switch` hook) must render a
   * per-shell-correct command itself; this function does not translate one
   * dialect into another.
   */
  readonly command: string;
}

/**
 * A directory-change hook — the reason this package exists. Each shell's
 * backend renders its own real mechanism (zsh's `chpwd_functions`, bash's
 * dedupe-guarded `PROMPT_COMMAND`, fish's `--on-variable PWD`, nu's
 * `hooks.env_change.PWD`, PowerShell's `LocationChangedAction`) — see
 * `docs/shell-notes.md` for what was verified in a container for each.
 */
export const hook = (id: string, props: HookProps) => {
  const { backend, path } = targetOf(props);
  return Dotfiles.ManagedBlock(id, {
    path,
    marker: `shell-hook:${props.name}`,
    commentPrefix: backend.commentPrefix,
    content: backend.renderHook({
      name: props.name,
      pathGlob: props.pathGlob,
      command: props.command,
    }),
    ...(props.after !== undefined ? { after: props.after } : {}),
  });
};

export interface EnsureLoginShellLoadsRcProps {
  readonly shell: ShellId;
  /** The rc path a login shell should end up loading. Defaults to the backend's own `rcPath`. */
  readonly rcPath?: string;
}

/**
 * Makes a *login* invocation of `props.shell` also load `props.rcPath` (or
 * the backend's default `rcPath`), for the one shell where that isn't
 * already true — bash. A no-op for every other shell, so a recipe can call
 * this unconditionally without branching on which shell it's targeting.
 *
 * Deliberately not called automatically by `envVar`/`pathEntry`/`alias`/
 * `hook` — see `ShellBackend.loginRc`'s doc comment and `backends/Bash.ts`
 * for why doing so implicitly would risk silently taking over a second rc
 * file (`~/.bash_profile`) a recipe never asked to manage.
 *
 * Call this once per recipe, if at all — every call targets the same
 * physical region (`backend.loginRc.path`, marker `"shell-login-bootstrap"`)
 * regardless of `id`, so two calls converge the same content rather than
 * conflicting, but there is still no reason to call it more than once.
 */
export const ensureLoginShellLoadsRc = (id: string, props: EnsureLoginShellLoadsRcProps) =>
  Effect.gen(function* () {
    const backend = shellBackend(props.shell);
    if (backend.loginRc === undefined) return undefined;
    const rcPath = props.rcPath ?? backend.rcPath;
    return yield* Dotfiles.ManagedBlock(id, {
      path: backend.loginRc.path,
      marker: "shell-login-bootstrap",
      commentPrefix: backend.commentPrefix,
      content: backend.loginRc.render(rcPath),
    });
  });
