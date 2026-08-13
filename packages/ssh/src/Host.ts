import * as Dotfiles from "@machine-run/dotfiles";
import * as Effect from "effect/Effect";

export interface SshHostProps {
  /** Absolute path to `~/.ssh/config`. */
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
}

/**
 * One `Host` block in `~/.ssh/config`, via {@link Dotfiles.ManagedBlock} —
 * makes adding a new server "one thing to reconcile" instead of hand-editing
 * ssh config. Never touches private key material itself; pair with
 * `@machine-run/secrets`'s `Machine.SecretFile` for that.
 */
export const sshHost = (props: SshHostProps) =>
  Effect.gen(function* () {
    const lines = [`Host ${props.hostnames.join(" ")}`];
    if (props.user) lines.push(`\tUser ${props.user}`);
    if (props.identityFile) lines.push(`\tIdentityFile ${props.identityFile}`);
    if (props.proxyCommand) lines.push(`\tProxyCommand ${props.proxyCommand}`);
    for (const [key, value] of Object.entries(props.extra ?? {})) {
      lines.push(`\t${key} ${value}`);
    }

    yield* Dotfiles.ManagedBlock(`ssh-host-${props.name}`, {
      path: props.configPath,
      marker: `ssh-host:${props.name}`,
      content: lines.join("\n"),
    });
  });
