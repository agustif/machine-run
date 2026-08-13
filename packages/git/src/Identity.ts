import * as Dotfiles from "@machine-run/dotfiles";
import * as Shell from "@machine-run/shell";
import * as Effect from "effect/Effect";
import { Config } from "./Config.ts";

export interface GitPersonaProps {
  /** Short slug, e.g. "personal" or "obvious". Used in the generated filename and logical ids. */
  persona: string;
  name: string;
  email: string;
  signingKey?: string;
  /** Glob passed to `includeIf.gitdir:<pathGlob>.path` — repos under this path use this persona. */
  pathGlob: string;
  /** Absolute path to this persona's own generated config file, e.g. `~/.gitconfig-personal`. */
  personaConfigPath: string;
  /**
   * @deprecated Unused. {@link Config} always writes the one global scope,
   * so there is no longer a file path for this composition to choose — see
   * this module's doc comment. Kept only so `@machine-run/git-identity`'s
   * re-export doesn't break existing callers that still pass it (currently
   * `examples/example-machine`); drop it once those are updated, tracked
   * alongside removing `git-identity` itself before 1.0 (`docs/git-notes.md`).
   */
  gitconfigPath?: string;
  /**
   * If set (with `shellRcPath`), switches the active `gh` CLI account to this
   * login via a directory-change hook (rendered by `@machine-run/shell` for
   * whichever `shell` is configured) whenever you `cd` under `pathGlob`.
   * `gh`'s active account is a single global CLI setting, not per-directory,
   * so this is a shell hook rather than a resource of its own.
   */
  ghAccount?: string;
  /**
   * Required when `ghAccount` is set — absolute path to the rc file the hook
   * is written into: `~/.zshrc` for `"zsh"`, `~/.bashrc` for `"bash"`,
   * `~/.config/fish/config.fish` for `"fish"`.
   */
  shellRcPath?: string;
  /**
   * Which shell's directory-change hook syntax to render into `shellRcPath`.
   *
   * @default "zsh"
   */
  shell?: "zsh" | "bash" | "fish";
  /**
   * Forces this persona's `includeIf` key to be written after another
   * persona's — see {@link Config.GitConfigProps.after}.
   *
   * The global gitconfig is **last**-match-wins for `includeIf`: git
   * evaluates every matching entry in file order and the last one to set a
   * given key sticks. So a broad persona (`pathGlob: "~/work/**"`) must land
   * BEFORE a narrower one nested inside it (`pathGlob: "~/work/oss/**"`), or
   * the broad entry's `path =` overwrites the narrow one's for any repo
   * under both. Alchemy has no implicit ordering between two independent
   * resources touching the same file, so pass the broad persona's returned
   * `gitconfigInclude.values` here, on the narrow persona's `gitIdentity(...)`
   * call, to make that ordering explicit.
   */
  after?: readonly string[];
}

const renderPersonaConfig = (props: GitPersonaProps) =>
  [
    "[user]",
    `\tname = ${props.name}`,
    `\temail = ${props.email}`,
    ...(props.signingKey ? [`\tsigningkey = ${props.signingKey}`] : []),
    "",
  ].join("\n");

/**
 * Converts a git `includeIf gitdir:` glob (e.g. `/Users/a/work/**`) into a
 * shell `case`/`switch` pattern (`/Users/a/work/*`).
 *
 * Must insert the `/` that `**` implies: naively replacing the trailing
 * `/**` with `*` turns `/Users/a/work/**` into `/Users/a/work*`, which also
 * matches an unrelated sibling directory like `/Users/a/workshop`. Keeping
 * the slash makes the pattern match only `/Users/a/work` itself and its
 * descendants. `@machine-run/shell`'s `Backend.ts` names this exact
 * function by reference — this is the conversion it expects a caller like
 * this one to do before calling `Shell.hook`.
 */
const toShellGlob = (pathGlob: string) => `${pathGlob.replace(/\/\*\*$/, "/*")}`;

/**
 * Composes `Dotfiles.File` (the persona's own config), {@link Config} (the
 * `includeIf.gitdir:<glob>.path` key in the global gitconfig), and
 * optionally `@machine-run/shell`'s `hook` (the `gh` account directory-
 * change hook in the shell rc file) into one git identity.
 *
 * The `includeIf` stanza moved from `Dotfiles.ManagedBlock` (a hand-marked
 * text region) to {@link Config} (one config key) when this package absorbed
 * `git-identity`: verified that `includeIf.gitdir:<glob>.path` is a real,
 * settable `git config` key — `git config --global
 * "includeIf.gitdir:/x/**.path" /y"` produces byte-for-byte the same
 * `[includeIf "gitdir:/x/**"]\n\tpath = /y` stanza a hand-written one would.
 * There is no longer a `gitconfigPath` prop, because {@link Config} always
 * operates on the one global scope — the caller no longer has to say which
 * file, only what the key/value is.
 *
 * The `gh` account hook delegates to `@machine-run/shell`'s `hook`
 * composition rather than rendering zsh/bash/fish syntax by hand, the way
 * this module used to. `Shell.hook` renders each shell's real directory-
 * change mechanism (container-verified per its own doc comment) and passes
 * the `command` through verbatim rather than translating between dialects —
 * so the glob still has to be converted from git's `gitdir:` syntax first,
 * which is what {@link toShellGlob} is for.
 *
 * One real behavioural difference from the `ManagedBlock` version, worth
 * knowing before relying on it: `Config`'s `apply` always clears and
 * re-appends a key's values (see its doc comment), so *changing* an existing
 * persona's `pathGlob` or `personaConfigPath` moves its `includeIf` entry to
 * the end of the global gitconfig, not just its content — `ManagedBlock`
 * rewrote in place. `after` still needs to be set correctly across a change
 * for exactly this reason.
 *
 * Not a custom `Resource` itself — just a reusable composition of the
 * primitives above. Returns the created resources so a caller composing
 * several personas can sequence them explicitly via {@link
 * GitPersonaProps.after} — see that prop's doc comment for why the last-
 * match-wins semantics make this ordering load-bearing rather than
 * cosmetic.
 */
export const gitIdentity = (props: GitPersonaProps) =>
  Effect.gen(function* () {
    const personaConfig = yield* Dotfiles.File(`gitconfig-${props.persona}`, {
      path: props.personaConfigPath,
      content: renderPersonaConfig(props),
    });

    const gitconfigInclude = yield* Config(`gitconfig-include-${props.persona}`, {
      key: `includeIf.gitdir:${props.pathGlob}.path`,
      values: [props.personaConfigPath],
      ...(props.after !== undefined ? { after: props.after } : {}),
    });

    let ghAccountHook: Dotfiles.ManagedBlock | undefined;
    if (props.ghAccount && props.shellRcPath) {
      const ghAccount = props.ghAccount;
      ghAccountHook = yield* Shell.hook(`gh-account-${props.persona}`, {
        shell: props.shell ?? "zsh",
        rcPath: props.shellRcPath,
        name: `gh_${props.persona}`,
        pathGlob: toShellGlob(props.pathGlob),
        // Suppressing output is plain POSIX redirection, valid verbatim in
        // zsh/bash/fish alike — this module only ever asks `Shell.hook` for
        // one of those three, never `nu`/`pwsh`, whose redirection syntax
        // differs.
        command: `gh auth switch --user ${ghAccount} >/dev/null 2>&1`,
      });
    }

    return { personaConfig, gitconfigInclude, ghAccountHook };
  });
