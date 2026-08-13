import { CommandExecutor, type CommandError } from "alchemy/Command";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";

export class OnePasswordCliMissing extends Data.TaggedError("OnePasswordCliMissing")<{
  cause: CommandError;
}> {
  override get message() {
    return '1Password CLI ("op") is not installed or not on PATH. Install it — e.g. add the "1password-cli" cask to this machine\'s Homebrew bundle — before this resource can read secrets.';
  }
}

export class OnePasswordAuthRequired extends Data.TaggedError("OnePasswordAuthRequired")<{
  cause: CommandError;
}> {
  override get message() {
    return 'The 1Password CLI is not signed in. Run "op signin" yourself — machine-run deliberately never automates authentication.';
  }
}

export class OnePasswordReadFailed extends Data.TaggedError("OnePasswordReadFailed")<{
  ref: string;
  cause: CommandError;
}> {
  override get message() {
    return `Failed to read "${this.ref}" from 1Password.`;
  }
}

export type OnePasswordError =
  | OnePasswordCliMissing
  | OnePasswordAuthRequired
  | OnePasswordReadFailed;

export class OnePassword extends Context.Service<
  OnePassword,
  {
    readonly read: (
      ref: string,
      session: ScopedPlanStatusSession,
    ) => Effect.Effect<string, OnePasswordError>;
  }
>()("machine-run/OnePassword") {}

const classifyFailure = (ref: string, cause: CommandError): OnePasswordError => {
  const message = cause.message.toLowerCase();
  if (message.includes("command not found") || message.includes("no such file")) {
    return new OnePasswordCliMissing({ cause });
  }
  if (
    message.includes("not signed in") ||
    message.includes("no valid session") ||
    message.includes("authentication")
  ) {
    return new OnePasswordAuthRequired({ cause });
  }
  return new OnePasswordReadFailed({ ref, cause });
};

export const OnePasswordLive = () =>
  Layer.effect(
    OnePassword,
    Effect.gen(function* () {
      const executor = yield* CommandExecutor;

      return {
        read: (ref, session) =>
          executor
            .run(
              // `shell: true` so the quoted ref (1Password item names often
              // contain spaces, e.g. "GitHub SSH Key") is parsed correctly.
              { command: `op read "${ref.replace(/"/g, '\\"')}"`, shell: true },
              session,
            )
            .pipe(
              Effect.map((result) => result.stdout.trim()),
              Effect.catchTag("CommandError", (error) =>
                Effect.fail(classifyFailure(ref, error)),
              ),
            ),
      };
    }),
  );
