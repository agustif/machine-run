import * as Dotfiles from "@machine-run/dotfiles";
import * as Effect from "effect/Effect";
import { Config } from "./Config.ts";

/** One trusted signer entry — see `man ssh-keygen`'s "ALLOWED SIGNERS" section. */
export interface GitAllowedSigner {
  /** Comma-separated principal(s) identifying the signer, e.g. `"me@example.com"`. */
  readonly principals: string;
  /** The full public key line, e.g. `"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5..."`. */
  readonly publicKey: string;
}

export interface GitSigningProps {
  /** The key used to sign — an SSH public key or `ssh-add -L`-style reference, `user.signingKey`. */
  readonly signingKey: string;
  /** Whether commits are signed by default, `commit.gpgsign`. */
  readonly commitGpgSign: boolean;
  /** Where the `allowed_signers` file should live, e.g. `~/.ssh/allowed_signers`. `~` is expanded. */
  readonly allowedSignersPath: string;
  /** Every signer this machine should trust when verifying commits/tags. */
  readonly allowedSigners: readonly GitAllowedSigner[];
}

/**
 * SSH-based commit/tag signing (`gpg.format = ssh`), plus the `allowed_
 * signers` file `gpg.ssh.allowedSignersFile` points at.
 *
 * A composition, not a `Reconciler`: four {@link Config} keys and one
 * generated file, none of which need a new state shape. **Nothing in this
 * repository signs anything today** — this composition exists but is not
 * called from any recipe yet, so it is unverified in the one way that
 * matters most: nobody has run `git commit -S` against a machine reconciled
 * by it and checked `git log --show-signature`.
 *
 * The `allowed_signers` file format (verified against `man git-config`'s
 * "gpg.ssh.allowedSignersFile" entry, which cites `ssh-keygen(1)`'s "ALLOWED
 * SIGNERS" section) is one line per signer: comma-separated principals, a
 * space, then the public key exactly as it appears in `authorized_keys` —
 * no support here for the optional `valid-after`/`valid-before`/
 * `cert-authority` qualifiers that section also documents, since nothing in
 * this package needs them yet.
 */
export const gitSigning = (id: string, props: GitSigningProps) =>
  Effect.gen(function* () {
    const allowedSigners = yield* Dotfiles.File(`${id}-allowed-signers`, {
      path: props.allowedSignersPath,
      content:
        props.allowedSigners.length > 0
          ? `${props.allowedSigners.map((s) => `${s.principals} ${s.publicKey}`).join("\n")}\n`
          : "",
    });

    const format = yield* Config(`${id}-format`, {
      key: "gpg.format",
      values: ["ssh"],
    });
    const signingKey = yield* Config(`${id}-signing-key`, {
      key: "user.signingKey",
      values: [props.signingKey],
    });
    const gpgSign = yield* Config(`${id}-gpgsign`, {
      key: "commit.gpgsign",
      values: [props.commitGpgSign ? "true" : "false"],
      type: "bool",
    });
    const allowedSignersFile = yield* Config(`${id}-allowed-signers-file`, {
      key: "gpg.ssh.allowedSignersFile",
      values: [props.allowedSignersPath],
    });

    return { allowedSigners, format, signingKey, gpgSign, allowedSignersFile };
  });
