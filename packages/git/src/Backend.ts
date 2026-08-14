import * as Schema from "effect/Schema";

/**
 * Every credential helper `Git.CredentialHelper` knows how to wire up.
 *
 * Mirrors `system-packages`' `PackageManagerBackend` and `secrets`'
 * `SecretBackend`: one small module per implementation, dispatched by id from
 * `Store.ts`, so adding a helper never means touching the composition
 * function itself. Deliberately simpler than those two seams — a helper
 * needs no `Exec` and cannot fail, because it only says what literal
 * string(s) belong in `credential.helper`, never runs a command itself.
 */
export const CredentialHelperBackendId = Schema.Literals(["osxkeychain", "libsecret", "gh"]);

export type CredentialHelperBackendId = typeof CredentialHelperBackendId.Type;

export interface CredentialHelperBackend {
  readonly id: CredentialHelperBackendId;
  /**
   * The literal `credential.helper` value(s) this backend contributes, in
   * the exact form git expects — a bare name git resolves on `PATH` as
   * `git-credential-<name>`, an absolute path, or (prefixed with `!`) a shell
   * command. `git config` genuinely supports several `credential.helper`
   * entries at once (`man git-config`: "multiple helpers may be defined"),
   * which is why this is an array rather than a single string — most
   * backends contribute exactly one value, but nothing stops one from
   * contributing more.
   */
  readonly values: readonly string[];
}
