import * as Ssh from "@machine-run/ssh";
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
    authKey: { _tag: "OnePassword", vault: "Personal", item: "Tailscale", field: "authkey" },
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

  // A generated keypair. `Ssh.Key` means *generated here*, never materialised
  // from a vault — that is `Machine.SecretFile`'s job, and duplicating it would
  // be a second way to say one thing. Alchemy's own `KeyPair` is deliberately
  // not used: it persists the private half in state, which for a local state
  // file means a plaintext private key outside `~/.ssh`.
  //
  // There is no `unapply` for the same reason: a generated private key is not
  // derivable from anything retained, so deleting it on `destroy` would be an
  // unrecoverable loss.
  yield* Ssh.Key("personal-key", {
    path: "~/.ssh/id_ed25519_personal",
    algorithm: "ed25519",
    comment: "personal",
  });

  // A pinned host key. The key is stated, never fetched: trusting whatever
  // `ssh-keyscan` returns is precisely the trust-on-first-use problem this is
  // meant to close. A mismatch against an existing line raises rather than
  // being resolved either way — overwriting would trust a possibly-stale
  // recipe over an entry already trusted, and appending would leave the old
  // line trusted too, since ssh accepts a connection if any line matches.
  yield* Ssh.KnownHost("github", {
    host: "github.com",
    keyType: "ssh-ed25519",
    publicKey: "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  });
});
