import * as Secrets from "@machine-run/secrets";
import * as Effect from "effect/Effect";

/**
 * `Machine.SecretFile` across the secret backends.
 *
 * The secret's value is never in the recipe — only a reference to where it
 * lives. That is the whole point: this file is committed, and the state file
 * records a hash rather than the plaintext.
 *
 * Each backend needs to be authenticated already (`op signin`, `doppler
 * login`, an unlocked keychain, an initialised `pass` store). None of them are
 * something this repo can set up for you.
 */
export const secrets = Effect.gen(function* () {
  // `trailingNewline` is explicit per secret because getting it wrong fails
  // silently in opposite directions: OpenSSH rejects a private key that does
  // not end in a newline, while a token file with a stray newline breaks any
  // consumer doing an exact comparison.
  yield* Secrets.SecretFile("ssh-key", {
    path: "~/.ssh/id_ed25519_personal",
    source: {
      _tag: "OnePassword",
      vault: "Personal",
      item: "GitHub SSH Key",
      field: "private key",
    },
    mode: 0o600,
    directoryMode: 0o700,
    trailingNewline: "ensure",
  });

  yield* Secrets.SecretFile("npm-token", {
    path: "~/.config/complete-machine/npm-token",
    source: { _tag: "Doppler", project: "complete-machine", config: "dev", name: "NPM_TOKEN" },
    mode: 0o600,
    trailingNewline: "strip",
  });

  // `keychain` addresses by `service` or `service/account`.
  yield* Secrets.SecretFile("api-key-keychain", {
    path: "~/.config/complete-machine/api-key",
    source: { _tag: "Keychain", service: "complete-machine", account: "api" },
  });

  // `pass` addresses by store path.
  yield* Secrets.SecretFile("api-key-pass", {
    path: "~/.config/complete-machine/pass-token",
    source: { _tag: "Pass", path: "work/github/token" },
  });

  // `env` reads from this process's own environment, which makes it the one
  // backend usable in CI without a vault. It is also the weakest: whatever
  // exported the variable is now part of your trust boundary.
  yield* Secrets.SecretFile("ci-token", {
    path: "~/.config/complete-machine/ci-token",
    source: { _tag: "Env", variable: "GITHUB_TOKEN" },
  });
});
