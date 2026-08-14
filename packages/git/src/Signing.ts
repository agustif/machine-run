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
 * generated file, none of which need a new state shape.
 *
 * **Verified end to end** (`docker run --rm debian:stable`, git 2.47.3): a
 * throwaway `ssh-keygen -t ed25519` key, this composition's exact four
 * config keys, an `allowed_signers` file in the exact format generated
 * above, `git commit -S`, and `git verify-commit` — a real `Good "git"
 * signature for verify@machine-run.invalid ...` and exit `0`. The whole
 * chain this composition wires together does produce a commit that actually
 * verifies, not just one that looks signed.
 *
 * **A load-bearing, non-obvious finding from the same session, using three
 * negative controls**: `git verify-commit`'s SSH-format check is a
 * *key* lookup against `allowed_signers`, not an *identity* one —
 * the `principals` field is not cross-checked against the commit's actual
 * author/committer email at all.
 *
 * - Right key, listed under a **wrong** principal (`someone-else@example.com`,
 *   nothing to do with the real committer `verify@machine-run.invalid`):
 *   `git verify-commit` still prints `Good "git" signature for
 *   someone-else@example.com ...` and **exits `0`**.
 * - A **different** key listed under the *right* principal: prints `Good
 *   "git" signature with <fingerprint>` (the cryptographic check on the
 *   signature blob itself always succeeds or fails independently of the
 *   file) followed by `No principal matched.` and **exits `1`**.
 * - `allowedSignersFile` pointed at a path that doesn't exist: `Unable to
 *   open allowed keys file ...`, `No principal matched.`, **exits `1`**.
 *
 * Read together: the exact public key must appear somewhere in the file, or
 * verification fails outright — that part is real security. But once a key
 * is in the file, `git verify-commit` accepts a signature from it under
 * *any* principal string, including one that has nothing to do with who
 * actually holds that key. `GitAllowedSigner.principals` is therefore
 * legible audit metadata (which name a human attached to a key), never an
 * enforced identity binding — anyone whose key ends up in this file can
 * "look like" any principal already listed for a different key's sake, and
 * this composition cannot change that: it is exactly what `ssh-keygen(1)`'s
 * ALLOWED SIGNERS format and `git verify-commit` implement. Callers relying
 * on `gitSigning` for anything beyond "is this key trusted at all" should
 * know this before treating a passing `verify-commit` as proof of *who*
 * signed, not just *that* a trusted key did.
 *
 * The `allowed_signers` file format (verified against `man git-config`'s
 * "gpg.ssh.allowedSignersFile" entry, which cites `ssh-keygen(1)`'s "ALLOWED
 * SIGNERS" section, and now against the real behaviour above) is one line
 * per signer: comma-separated principals, a space, then the public key
 * exactly as it appears in `authorized_keys` — no support here for the
 * optional `valid-after`/`valid-before`/`cert-authority` qualifiers that
 * section also documents, since nothing in this package needs them yet.
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
