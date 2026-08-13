import { OnePassword } from "@machine-run/secrets";
import { CommandExecutor } from "alchemy/Command";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import * as Effect from "effect/Effect";

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
          if (!output) return { action: "update" as const };
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          const running = yield* isRunning(session);
          if (!running) {
            const authKey = yield* onePassword.read(news.authKeyOpRef, session);
            const hostnameFlag = news.hostname ? ` --hostname=${news.hostname}` : "";
            yield* executor.run(
              {
                command: `tailscale up --authkey=${authKey}${hostnameFlag}`,
                shell: true,
                timeout: "2 minutes",
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
