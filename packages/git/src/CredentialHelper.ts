import * as Effect from "effect/Effect";
import { type CredentialHelperBackendId } from "./backends/Backend.ts";
import { credentialHelperBackend } from "./backends/Store.ts";
import { Config } from "./Config.ts";

export interface GitCredentialHelperProps {
  /**
   * One or more helpers, tried in the order given — git itself falls
   * through to the next configured helper when one doesn't supply a
   * credential (`man git-config`'s `credential.helper`).
   */
  readonly helpers: readonly CredentialHelperBackendId[];
}

/**
 * Sets `credential.helper` from one or more backends, via {@link Config}.
 *
 * A composition, not a `Reconciler`: the backend seam
 * (`backends/Backend.ts` + `backends/*.ts`, dispatched from
 * `backends/Store.ts`) supplies the literal value(s); this just hands them
 * to the one resource that already knows how to converge a config key. This
 * is the pattern the whole system already uses for pluggable
 * implementations — see `system-packages`' `PackageManagerBackend` and
 * `secrets`' `SecretBackend` — applied to a case simple enough that the
 * generic side of the seam is `Config` itself rather than a bespoke
 * resource.
 */
export const gitCredentialHelper = (id: string, props: GitCredentialHelperProps) =>
  Effect.gen(function* () {
    return yield* Config(id, {
      key: "credential.helper",
      values: props.helpers.flatMap((helper) => credentialHelperBackend(helper).values),
    });
  });
