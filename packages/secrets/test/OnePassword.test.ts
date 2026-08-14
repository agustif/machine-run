import type { Exec } from "@machine-run/engine";
import { CommandError, UnexpectedExit } from "alchemy/Command";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { OnePasswordBackend } from "../src/backends/OnePassword.ts";
import { SecretAuthRequired } from "../src/Backend.ts";

const failingExec =
  (command: string, stderr: string): Exec =>
  () =>
    Effect.fail(new CommandError({ command, reason: new UnexpectedExit({ exitCode: 1, stderr }) }));

/**
 * Real captured `op read op://Personal/does-not-exist/field` stderr — 1Password
 * CLI 2.38.1, installed from the official apt repo inside `docker run --rm
 * debian:stable`, zero accounts ever configured. See
 * docs/notes/secrets-op-notes.md and
 * packages/secrets/test/fixtures/op-unauthenticated-stderr.txt for the full
 * session.
 */
const noAccountsStderr = `No accounts configured for use with 1Password CLI.

 - Turn on the 1Password desktop app integration to sign in with the accounts you've added to the app: https://www.1password.dev/cli/app-integration/ for details.
 - Add an account manually with 'op account add' and sign in by entering your password on the command line. See 'op account add --help' for details.
 - Authenticate using a 1Password service account by setting the 'OP_SERVICE_ACCOUNT_TOKEN' environment variable to your service account token. Learn more: https://www.1password.dev/service-accounts/
 - Use 1Password CLI with a Connect server by setting the 'OP_CONNECT_HOST' and 'OP_CONNECT_TOKEN' environment variables to your Connect host and token, respectively. Learn more: https://www.1password.dev/connect/
[ERROR] 2026/08/14 04:07:09 could not read secret 'op://Personal/does-not-exist/field': error initializing client:
`;

it.effect(
  "OnePasswordBackend.read classifies a real zero-accounts-configured `op` as SecretAuthRequired",
  () =>
    Effect.gen(function* () {
      // Before this session, `classify` only matched "not signed in" /
      // "no valid session" / "authentication" — none of which appear in the
      // real text above (it reads "Authenticate", not "authentication"), so
      // this real and very-likely-to-be-hit state used to fall through to
      // the generic SecretReadFailed bucket instead.
      const failure = yield* OnePasswordBackend.read(
        { _tag: "OnePassword", vault: "Personal", item: "does-not-exist", field: "field" },
        failingExec('op read "op://Personal/does-not-exist/field"', noAccountsStderr),
      ).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(SecretAuthRequired);
      expect(failure).toMatchObject({
        source: { _tag: "OnePassword", vault: "Personal", item: "does-not-exist", field: "field" },
        signInCommand: "op signin",
      });
    }),
);
