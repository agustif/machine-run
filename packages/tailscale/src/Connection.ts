import { Sh } from "@machine-run/core";
import { type Reconciler, toProvider } from "@machine-run/engine";
import { readSecret, SecretSource, type SecretError } from "@machine-run/secrets";
import type { CommandError } from "alchemy/Command";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as UndefinedOr from "effect/UndefinedOr";

export const TailscaleConnectionProps = Schema.Struct({
  /** Which secret store the auth key lives in. @default "1password" */
  /**
   * Where the tailnet auth key is read from.
   *
   * One tagged value rather than a store name beside a loose reference string,
   * so a 1Password source cannot be paired with, say, an environment variable
   * name — the store and the fields it needs travel together.
   */
  authKey: SecretSource,

  /** Device name to advertise on the tailnet. Defaults to the OS hostname. */
  hostname: Schema.optionalKey(Schema.String),
});

export type TailscaleConnectionProps = typeof TailscaleConnectionProps.Type;

/**
 * Being on the tailnet is the state; `hostname` is the one mutable aspect of
 * it. Absence of this state means the daemon is not up and authenticated, so
 * observing it is what makes a logged-out or stopped daemon reconnect on the
 * next apply rather than being reported as unchanged forever.
 */
export const TailscaleConnectionState = Schema.Struct({
  hostname: Schema.optionalKey(Schema.String),
});

export type TailscaleConnectionState = typeof TailscaleConnectionState.Type;

export interface TailscaleConnection extends Resource<
  "Tailscale.Connection",
  TailscaleConnectionProps,
  TailscaleConnectionState
> {}

export const TailscaleConnection = Resource<TailscaleConnection>("Tailscale.Connection");

/**
 * The `tailscale` CLI is not installed, or not on `PATH`.
 *
 * Distinguished from the other ways the liveness probe comes back negative —
 * logged out, daemon stopped, unparseable status output. Folding them together
 * would let a missing binary be answered with `tailscale up`, which fails with
 * a `CommandError` about a command that was never there instead of telling the
 * operator to install it.
 */
export class TailscaleNotInstalled extends Data.TaggedError("TailscaleNotInstalled")<{
  cause: CommandError;
}> {
  override get message() {
    return `The "tailscale" CLI is not installed or not on PATH. Install it first — this resource never installs it for you.`;
  }
}

/**
 * The fields of `tailscale status --json` this resource reads.
 *
 * Decoded rather than cast, so a release that changes the shape, or stdout
 * that is not JSON at all, fails predictably at the boundary instead of
 * throwing inside a property access. Every field is optional because only
 * their presence is load-bearing, never their absence.
 *
 * `BackendState` and `Self.HostName` were not verified against a running
 * tailscaled — see docs/TASKS.md.
 */
const TailscaleStatus = Schema.fromJsonString(
  Schema.Struct({
    BackendState: Schema.optionalKey(Schema.String),
    Self: Schema.optionalKey(Schema.Struct({ HostName: Schema.optionalKey(Schema.String) })),
  }),
);

const decodeStatus = Schema.decodeUnknownEffect(TailscaleStatus);

/**
 * Best-effort sniff of a `CommandError` caused by a missing binary.
 *
 * Substring matching on OS error text is fragile — wording is not a stable
 * API — so this only ever promotes an error to a more actionable one, and
 * everything unmatched keeps its ordinary meaning.
 */
const isCommandNotFound = (error: CommandError): boolean => {
  const message = error.message.toLowerCase();
  return message.includes("command not found") || message.includes("enoent");
};

/**
 * `CommandError` is in the union because `tailscale up` failing is the most
 * likely outcome in this whole package, not an impossible one: a rejected or
 * expired auth key, an unreachable control plane, a daemon that is not running,
 * or a run without the privileges to join a tailnet all surface as a non-zero
 * exit. `apply` previously converted every one of those into a defect, which
 * nothing can catch and which aborts the run rather than failing this resource.
 */
export const makeTailscaleConnectionReconciler: Effect.Effect<
  Reconciler<
    TailscaleConnectionProps,
    TailscaleConnectionState,
    TailscaleNotInstalled | SecretError | CommandError
  >
> = Effect.succeed({
  // One tailnet membership per machine, so every instance contends for the
  // same daemon and applies are serialised against each other.
  address: () => "tailscale:connection",

  observe: (_props, ctx) =>
    ctx.exec({ command: Sh.sh("tailscale", "status", "--json") }).pipe(
      Effect.flatMap((result) => decodeStatus(result.stdout)),
      Effect.map((status) =>
        status.BackendState === "Running"
          ? { ...(status.Self?.HostName !== undefined ? { hostname: status.Self.HostName } : {}) }
          : undefined,
      ),
      Effect.catchTag("CommandError", (error) =>
        isCommandNotFound(error)
          ? Effect.fail(new TailscaleNotInstalled({ cause: error }))
          : // A non-zero exit means the daemon is not up or not logged in,
            // which is an ordinary state to converge from.
            Effect.succeed(undefined),
      ),
      // Output that will not decode means the state cannot be confirmed, which
      // is treated the same as not being connected.
      Effect.catchTag("SchemaError", () => Effect.succeed(undefined)),
    ),

  desired: (props) =>
    Effect.succeed(props.hostname !== undefined ? { hostname: props.hostname } : {}),

  // A recipe that does not pin a hostname is satisfied by whatever the tailnet
  // already advertises, so only a stated hostname is compared.
  matches: (observed, desired) =>
    UndefinedOr.match(desired.hostname, {
      onUndefined: () => true,
      onDefined: (hostname) => observed.hostname === hostname,
    }),

  apply: ({ props, observed, desired }, ctx) =>
    Effect.gen(function* () {
      const hostnameFlag = UndefinedOr.match(desired.hostname, {
        onUndefined: () => "",
        onDefined: () => ` --hostname=${Sh.ref("TS_HOSTNAME")}`,
      });
      // Typed as the record `CommandProps.env` expects, so a conditionally
      // absent key stays absent rather than becoming an explicit `undefined`
      // value the index signature rejects.
      const hostnameEnv: Record<string, string | Redacted.Redacted<string>> = UndefinedOr.match(
        desired.hostname,
        { onUndefined: () => ({}), onDefined: (hostname) => ({ TS_HOSTNAME: hostname }) },
      );

      if (observed === undefined) {
        const authKey = yield* readSecret(props.authKey, ctx.exec);

        yield* ctx.exec({
          // The key and hostname reach the process through `env` (a
          // `Redacted` for the key), never through the command string: an
          // interpolated value is visible in `ps` output and in any
          // `CommandError` message, while Alchemy's redactor scrubs values
          // passed this way. `Sh.sh`'s argv quoting cannot express a `"$VAR"`
          // reference either — it would single-quote the `$` and suppress
          // the very expansion this needs — so this is `Sh.ref` spliced into
          // an explicit `Sh.unsafeRaw`, not a value being interpolated.
          command: Sh.unsafeRaw(
            `tailscale up --authkey=${Sh.ref("TS_AUTHKEY")}${hostnameFlag}`,
            "references $TS_AUTHKEY/$TS_HOSTNAME via env so neither reaches the command string; Sh.sh's argv quoting would single-quote the $ and break the expansion",
          ),
          shell: true,
          env: { TS_AUTHKEY: authKey, ...hostnameEnv },
          timeout: "2 minutes",
        });
        return desired;
      }

      // Already on the tailnet, so only the hostname needs moving.
      yield* ctx.exec({
        command: UndefinedOr.match(desired.hostname, {
          onUndefined: () => Sh.sh("tailscale", "set", "--hostname="),
          onDefined: () =>
            Sh.unsafeRaw(
              `tailscale set --hostname=${Sh.ref("TS_HOSTNAME")}`,
              "references $TS_HOSTNAME via env; same reason as tailscale up above",
            ),
        }),
        shell: true,
        env: hostnameEnv,
        timeout: "1 minute",
      });
      return desired;
    }).pipe(
      // A missing binary is worth its own error because the remedy is
      // different (install tailscale, versus look at why the join was
      // refused); everything else is reported as the command failure it is.
      // The handler is annotated rather than inferred: both branches fail, with
      // different error types, and inference otherwise narrows to whichever
      // branch it reads first.
      Effect.catchTag(
        "CommandError",
        (error): Effect.Effect<never, TailscaleNotInstalled | CommandError> =>
          isCommandNotFound(error)
            ? Effect.fail(new TailscaleNotInstalled({ cause: error }))
            : Effect.fail(error),
      ),
    ),
});

export const TailscaleConnectionProvider = () =>
  toProvider(TailscaleConnection, makeTailscaleConnectionReconciler);
