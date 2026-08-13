import { OnePassword } from "@machine-run/secrets";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import { CommandExecutor } from "alchemy/Command";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export interface TailscaleConnectionProps {
  /** 1Password reference to a Tailscale auth key, e.g. "op://Personal/Tailscale/authkey". */
  authKeyOpRef: string;
  /** Optional device name to advertise on the tailnet; defaults to the OS hostname. */
  hostname?: string;
}

export interface TailscaleConnection
  extends Resource<
    "Tailscale.Connection",
    TailscaleConnectionProps,
    { hostname: string | undefined }
  > {}

export const TailscaleConnection = Resource<TailscaleConnection>("Tailscale.Connection");

interface TailscaleSelfStatus {
  BackendState?: string;
}

export const TailscaleConnectionProvider = () =>
  Provider.effect(
    TailscaleConnection,
    Effect.gen(function* () {
      const executor = yield* CommandExecutor;
      const onePassword = yield* OnePassword;

      // Any failure here (tailscale not installed, not yet logged in, bad
      // JSON) just means "not running" — never a reason to blow up the plan.
      const isRunning = (session: ScopedPlanStatusSession) =>
        Effect.gen(function* () {
          const result = yield* executor.run({ command: "tailscale status --json" }, session);
          const parsed = yield* Effect.try(() => JSON.parse(result.stdout) as TailscaleSelfStatus);
          return parsed.BackendState === "Running";
        }).pipe(Effect.orElseSucceed(() => false));

      return TailscaleConnection.Provider.of({
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
          if (!output || output.hostname !== news.hostname) {
            return { action: "update" as const };
          }
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          const running = yield* isRunning(session);
          if (!running) {
            const authKey = yield* onePassword.read(news.authKeyOpRef, session);
            const hostnameFlag = news.hostname ? ` --hostname="$TS_HOSTNAME"` : "";
            yield* executor.run(
              {
                // The auth key never touches the command string or argv —
                // it's passed via `env` as `Redacted` so alchemy's own
                // command-error redaction can scrub it, and it's never
                // visible to `ps`/other processes the way an interpolated
                // `--authkey=<value>` argument would be.
                command: `tailscale up --authkey="$TS_AUTHKEY"${hostnameFlag}`,
                shell: true,
                env: {
                  TS_AUTHKEY: Redacted.make(authKey),
                  ...(news.hostname ? { TS_HOSTNAME: news.hostname } : {}),
                },
                timeout: "2 minutes",
              },
              session,
            );
          } else if (output && output.hostname !== news.hostname) {
            // Already connected, but the desired hostname changed — apply
            // just that instead of silently claiming a change was made.
            yield* executor.run(
              {
                command: news.hostname ? `tailscale set --hostname="$TS_HOSTNAME"` : "tailscale set --hostname=",
                shell: true,
                env: news.hostname ? { TS_HOSTNAME: news.hostname } : {},
                timeout: "1 minute",
              },
              session,
            );
          }
          return { hostname: news.hostname };
        }),
        // Never runs `tailscale down`/logs the device out on destroy.
        delete: () => Effect.void,
      });
    }),
  );
