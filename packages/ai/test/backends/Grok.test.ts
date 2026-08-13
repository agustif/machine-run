import type { AiMcpServerDesired, AiToolContext } from "@machine-run/ai";
import { GrokBackend } from "@machine-run/ai";
import { CommandError, UnexpectedExit } from "alchemy/Command";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const fakeExec =
  (stdout: string): AiToolContext["exec"] =>
  () =>
    Effect.succeed({ exitCode: 0, stdout, stderr: "" });

const capturingExec = (
  stdout: string,
  calls: { command: string; env: Record<string, string | Redacted.Redacted<string>> }[],
): AiToolContext["exec"] =>
  (props) => {
    calls.push({ command: props.command, env: props.env ?? {} });
    return Effect.succeed({ exitCode: 0, stdout, stderr: "" });
  };

const failingExec =
  (error: CommandError): AiToolContext["exec"] =>
  () =>
    Effect.fail(error);

const dieFs = { exists: () => Effect.die("unused") } as unknown as AiToolContext["fs"];
const diePath = {} as AiToolContext["path"];
const ctxWith = (exec: AiToolContext["exec"]): AiToolContext => ({
  exec,
  fs: dieFs,
  path: diePath,
  home: "/home/irrelevant",
});

/**
 * Real `grok mcp list --json` output, captured against an isolated `$HOME`
 * after `grok mcp add postgres -e DATABASE_URL=... -- npx -y
 * @modelcontextprotocol/server-postgres`. Grok has no `mcp get <name>`, so
 * this is the whole registry — the fixture includes a server this backend
 * is not asking about, exercising the by-name filter.
 */
const REAL_GROK_LIST = JSON.stringify([
  {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    env: { DATABASE_URL: "postgres://localhost/mydb" },
    enabled: true,
    name: "postgres",
    scope: "user",
  },
]);

it.effect("observe finds the named server within grok's full `mcp list --json` registry", () =>
  Effect.gen(function* () {
    const observed = yield* GrokBackend.mcp!.observe("postgres", ctxWith(fakeExec(REAL_GROK_LIST)));
    expect(observed).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-postgres"],
      env: { DATABASE_URL: "postgres://localhost/mydb" },
    });
  }),
);

it.effect("observe reports undefined for a name absent from the registry", () =>
  Effect.gen(function* () {
    const observed = yield* GrokBackend.mcp!.observe(
      "does-not-exist",
      ctxWith(fakeExec(REAL_GROK_LIST)),
    );
    expect(observed).toBeUndefined();
  }),
);

it.effect("observe reports AiToolCliMissing when the grok binary itself is absent", () =>
  Effect.gen(function* () {
    const error = new CommandError({
      command: "grok mcp list --json",
      reason: new UnexpectedExit({ exitCode: 127, stderr: "grok: command not found" }),
    });
    const failure = yield* GrokBackend.mcp!
      .observe("x", ctxWith(failingExec(error)))
      .pipe(Effect.flip);
    expect(failure).toMatchObject({ _tag: "AiToolCliMissing", tool: "grok" });
  }),
);

it.effect("apply builds a stdio `grok mcp add` with a literal env value quoted in the command", () =>
  Effect.gen(function* () {
    const calls: { command: string; env: Record<string, string | Redacted.Redacted<string>> }[] = [];
    const desired: AiMcpServerDesired = {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-postgres"],
      env: { LOG_LEVEL: "debug" },
    };
    yield* GrokBackend.mcp!.apply("postgres", desired, ctxWith(capturingExec("", calls)));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe(
      "grok mcp add -e LOG_LEVEL=debug postgres -- npx -y @modelcontextprotocol/server-postgres",
    );
  }),
);

it.effect(
  "apply for a remote server never puts a secret header value into the command string",
  () =>
    Effect.gen(function* () {
      const calls: { command: string; env: Record<string, string | Redacted.Redacted<string>> }[] = [];
      const secret = Redacted.make("Bearer sk-super-secret-value");
      const desired: AiMcpServerDesired = {
        url: "https://mcp.sentry.dev/mcp",
        headers: { Authorization: secret },
      };
      yield* GrokBackend.mcp!.apply("sentry", desired, ctxWith(capturingExec("", calls)));

      expect(calls).toHaveLength(1);
      expect(calls[0]!.command).not.toContain("sk-super-secret-value");
      expect(calls[0]!.command).toBe(
        'grok mcp add --transport http sentry https://mcp.sentry.dev/mcp -H "Authorization: $MCP_SECRET_H0"',
      );
      expect(Redacted.value(calls[0]!.env.MCP_SECRET_H0 as Redacted.Redacted<string>)).toBe(
        "Bearer sk-super-secret-value",
      );
    }),
);
