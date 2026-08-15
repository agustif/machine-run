import { DEFAULT_DIRECTORY_MODE } from "@machine-run/core";
import * as Dotfiles from "@machine-run/dotfiles";

export interface SshHostProps {
  /** Path to `~/.ssh/config`. `~` is expanded. */
  configPath: string;
  /** Short id for this host block, e.g. "exe" — used as the managed-block marker. */
  name: string;
  /** `Host` patterns, e.g. ["exe.dev", "*.exe.xyz"]. */
  hostnames: string[];
  user?: string;
  identityFile?: string;
  proxyCommand?: string;
  /** Escape hatch for any other `ssh_config` key not covered above, e.g. { ForwardAgent: "yes" }. */
  extra?: Record<string, string>;
  /**
   * Forces this block to be written after another block's `hash` output —
   * see {@link Dotfiles.ManagedBlockProps.after}.
   *
   * `ssh_config` is first-match-wins, so a catch-all block (e.g.
   * `hostnames: ["*"]`) MUST land after every more specific `Host` block or
   * it silently shadows all of them for any key they share. Alchemy has no
   * implicit ordering between two independent resources that target the
   * same file, so pass the specific blocks' `.hash` here — on the
   * catch-all's own `sshHost(...)` call — to make that ordering explicit
   * rather than leaving it to the engine's concurrent scheduling.
   */
  after?: string;
}

/**
 * One `Host` block in `~/.ssh/config`, via {@link Dotfiles.ManagedBlock} —
 * makes adding a new server "one thing to reconcile" instead of hand-editing
 * ssh config. Never touches private key material itself; pair with
 * `@machine-run/secrets`'s `Machine.SecretFile` for that.
 *
 * ## Why `~/.ssh` needs an explicit directory mode
 *
 * `ssh` refuses to read anything under `~/.ssh` — including `config` and
 * private keys — unless the directory itself is `0700`. `ManagedBlock` has
 * no safe default directory mode (most managed files aren't ssh config), so
 * this composition passes `directoryMode: 0o700` explicitly whenever it has
 * to create `~/.ssh`. `~/.ssh/config` itself should also be `0600`; that's
 * outside what a block-scoped resource can enforce (`ManagedBlock` only
 * ever owns a slice of an existing file, never the whole file's mode) —
 * chmod it yourself once, or manage it as a `Dotfiles.File` if you want the
 * whole file's mode enforced on every apply.
 *
 * ## Why new blocks default to prepending
 *
 * `ssh_config` is first-match-wins: the first `Host` stanza matching a
 * pattern wins and every later stanza for the same key is ignored. Most
 * hand-maintained `~/.ssh/config` files that predate machine-run already
 * carry a `Host *` catch-all for shared defaults (`ForwardAgent`,
 * `IdentitiesOnly`, etc.), often near the top. Appending a new block after
 * that catch-all means ssh never even reads the new block's settings for
 * any key the catch-all also sets — the new host silently gets the
 * catch-all's values instead of its own. Prepending instead means a new
 * block always wins over whatever hand-written content already exists,
 * which is the behaviour an operator adding "one more host" actually wants.
 * This only governs where a block is inserted the first time it's created;
 * an existing marked block is always updated in place afterward — see
 * {@link Dotfiles.ManagedBlockProps.position}.
 */
export const sshHost = (props: SshHostProps) =>
  Dotfiles.ManagedBlock(`ssh-host-${props.name}`, sshHostBlockProps(props));

/**
 * The `Dotfiles.ManagedBlockProps` `sshHost` hands to `Dotfiles.ManagedBlock`
 * — split out as a pure function, rather than inlined in {@link sshHost},
 * because `Dotfiles.ManagedBlock(id, props)` returns an `Effect` that only
 * resolves inside a running Alchemy stack. Rendering the block's content and
 * choosing its position/mode needs none of that, so keeping it a plain
 * function lets it be tested directly (see `test/Host.test.ts`) the same way
 * `Dotfiles.ManagedBlock`'s own `renderFile`/`readBlock` are pure and tested
 * without a filesystem.
 *
 * `path` is passed straight through, `~` and all — this function never
 * expands it. Expansion is `Dotfiles.ManagedBlock`'s reconciler's job (via
 * `MachinePaths`, at observe/apply time), not this composition's; doing it
 * twice would only risk the two disagreeing.
 */
export const sshHostBlockProps = (props: SshHostProps): Dotfiles.ManagedBlockProps => {
  const lines = [`Host ${props.hostnames.join(" ")}`];
  if (props.user) lines.push(`\tUser ${props.user}`);
  if (props.identityFile) lines.push(`\tIdentityFile ${props.identityFile}`);
  if (props.proxyCommand) lines.push(`\tProxyCommand ${props.proxyCommand}`);
  for (const [key, value] of Object.entries(props.extra ?? {})) {
    lines.push(`\t${key} ${value}`);
  }

  return {
    path: props.configPath,
    marker: `ssh-host:${props.name}`,
    content: lines.join("\n"),
    position: "prepend",
    directoryMode: DEFAULT_DIRECTORY_MODE,
    ...(props.after !== undefined ? { after: props.after } : {}),
  };
};
