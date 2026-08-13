import { sshHost } from "@machine-run/ssh";
import * as Tailscale from "@machine-run/tailscale";
import * as Effect from "effect/Effect";

/**
 * `Tailscale.Connection` and `sshHost`.
 *
 * Both touch files and daemons that predate this repo on any real machine.
 * `sshHost` writes a managed block into `~/.ssh/config`, so an existing
 * hand-written `Host` block for the same name has to be removed first —
 * otherwise ssh resolves the first match and the managed one is silently
 * ignored.
 */
export const network = Effect.gen(function* () {
  // The auth key is a reference, never a literal — the same rule as
  // `Machine.SecretFile`, for the same reason.
  yield* Tailscale.TailscaleConnection("tailnet", {
    authKeySource: "1password",
    authKeyRef: "op://Personal/Tailscale/authkey",
    hostname: "complete-machine",
  });

  yield* sshHost({
    configPath: "~/.ssh/config",
    name: "homelab",
    hostnames: ["homelab.example.com"],
    user: "you",
    identityFile: "~/.ssh/id_ed25519_personal",
  });

  // A host reached through another, with backend-specific options passed
  // verbatim as `extra`.
  yield* sshHost({
    configPath: "~/.ssh/config",
    name: "behind-bastion",
    hostnames: ["10.0.0.5"],
    user: "you",
    proxyCommand: "ssh -W %h:%p homelab",
    extra: { ForwardAgent: "yes", ServerAliveInterval: "60" },
  });
});
