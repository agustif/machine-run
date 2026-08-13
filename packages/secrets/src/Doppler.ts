import { CommandExecutor, type CommandError } from "alchemy/Command";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * The boundary between the two secret backends already on this machine:
 *
 * - **1Password** ({@link ../OnePassword.ts}) materializes individual
 *   credential *files* onto disk (SSH keys, etc.) — for things a process
 *   needs to find at a path.
 * - **Doppler** (this file) injects *environment variables* into a running
 *   command at launch time — for work/project secrets meant to be read from
 *   `process.env`, never written to disk at all.
 *
 * Neither backend's actual secret values ever pass through machine-run's own
 * state, for the same reason `Machine.SecretFile` never hashes its content:
 * Alchemy's local state is unencrypted JSON.
 */
export class DopplerRunFailed extends Data.TaggedError("DopplerRunFailed")<{
  command: string;
  cause: CommandError;
}> {
  override get message() {
    return `"doppler run" failed for "${this.command}".`;
  }
}

export class Doppler extends Context.Service<
  Doppler,
  {
    readonly run: (
      params: { project: string; config: string; command: string },
      session: ScopedPlanStatusSession,
    ) => Effect.Effect<{ stdout: string; stderr: string }, DopplerRunFailed>;
  }
>()("machine-run/Doppler") {}

export const DopplerLive = () =>
  Layer.effect(
    Doppler,
    Effect.gen(function* () {
      const executor = yield* CommandExecutor;

      return {
        run: ({ project, config, command }, session) =>
          executor
            .run(
              {
                command: `doppler run --project ${project} --config ${config} -- ${command}`,
                shell: true,
              },
              session,
            )
            .pipe(
              Effect.catchTag("CommandError", (error) =>
                Effect.fail(new DopplerRunFailed({ command, cause: error })),
              ),
            ),
      };
    }),
  );
