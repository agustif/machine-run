import type { AiMcpServerDesired, AiToolContext } from "@machine-run/ai";
import { CodexBackend } from "@machine-run/ai";
import { CommandError, UnexpectedExit } from "alchemy/Command";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/** A command runner returning fixed output — see `system-packages/test/backends.test.ts`. */
const fakeExec =
  (stdout: string): AiToolContext["exec"] =>
  () =>
    Effect.succeed({ exitCode: 0, stdout, stderr: "" });

/** The same, but recording the command string and env it was asked to run. */
const capturingExec =
  (
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

/** Never touched by this backend — placeholders to satisfy `AiToolContext`'s shape. */
const dieFs = { exists: () => Effect.die("unused") } as unknown as AiToolContext["fs"];
const diePath = {} as AiToolContext["path"];
const ctxWith = (exec: AiToolContext["exec"]): AiToolContext => ({
  exec,
  fs: dieFs,
  path: diePath,
  home: "/home/irrelevant",
});

/** Real `codex mcp get testserver --json` output, captured against an isolated `$CODEX_HOME`. */
const REAL_CODEX_GET_STDIO = JSON.stringify({
  name: "testserver",
  enabled: true,
  disabled_reason: null,
  transport: {
    type: "stdio",
    command: "npx",
    args: ["-y", "my-mcp-server"],
    env: { API_KEY: "xxx" },
    env_vars: [],
    cwd: null,
  },
  enabled_tools: null,
  disabled_tools: null,
  startup_timeout_sec: null,
  tool_timeout_sec: null,
});

/** Real `codex mcp get httptest --json` output for a remote server. */
const REAL_CODEX_GET_HTTP = JSON.stringify({
  name: "httptest",
  enabled: true,
  disabled_reason: null,
  transport: {
    type: "streamable_http",
    url: "https://example.com/mcp",
    bearer_token_env_var: null,
    http_headers: null,
    env_http_headers: null,
  },
  enabled_tools: null,
  disabled_tools: null,
  startup_timeout_sec: null,
  tool_timeout_sec: null,
});

it.effect("observe decodes a real stdio `codex mcp get --json` response", () =>
  Effect.gen(function* () {
    const observed = yield* CodexBackend.mcp!.observe(
      "testserver",
      ctxWith(fakeExec(REAL_CODEX_GET_STDIO)),
    );
    expect(observed).toEqual({
      command: "npx",
      args: ["-y", "my-mcp-server"],
      env: { API_KEY: "xxx" },
    });
  }),
);

it.effect("observe decodes a real remote `codex mcp get --json` response", () =>
  Effect.gen(function* () {
    const observed = yield* CodexBackend.mcp!.observe(
      "httptest",
      ctxWith(fakeExec(REAL_CODEX_GET_HTTP)),
    );
    expect(observed).toEqual({ url: "https://example.com/mcp" });
  }),
);

it.effect(
  "observe reports undefined for a server codex has never heard of, the real non-zero exit `codex mcp get` produces",
  () =>
    Effect.gen(function* () {
      const error = new CommandError({
        command: "codex mcp get doesnotexist --json",
        reason: new UnexpectedExit({
          exitCode: 1,
          stderr: "Error: No MCP server named 'doesnotexist' found.",
        }),
      });
      const observed = yield* CodexBackend.mcp!.observe(
        "doesnotexist",
        ctxWith(failingExec(error)),
      );
      expect(observed).toBeUndefined();
    }),
);

it.effect("observe reports AiToolCliMissing when the codex binary itself is absent", () =>
  Effect.gen(function* () {
    const error = new CommandError({
      command: "codex mcp get x --json",
      reason: new UnexpectedExit({ exitCode: 127, stderr: "codex: command not found" }),
    });
    const failure = yield* CodexBackend.mcp!.observe("x", ctxWith(failingExec(error))).pipe(
      Effect.flip,
    );
    expect(failure).toMatchObject({ _tag: "AiToolCliMissing", tool: "codex" });
  }),
);

it.effect(
  "apply builds `codex mcp add` with literal env values quoted directly in the command",
  () =>
    Effect.gen(function* () {
      const calls: { command: string; env: Record<string, string | Redacted.Redacted<string>> }[] =
        [];
      const desired: AiMcpServerDesired = {
        command: "npx",
        args: ["-y", "my-mcp-server"],
        env: { LOG_LEVEL: "debug" },
      };
      yield* CodexBackend.mcp!.apply("testserver", desired, ctxWith(capturingExec("", calls)));

      expect(calls).toHaveLength(1);
      expect(calls[0]!.command).toBe(
        "codex mcp add testserver --env LOG_LEVEL=debug -- npx -y my-mcp-server",
      );
      expect(calls[0]!.env).toEqual({});
    }),
);

it.effect(
  "apply never puts a secret-sourced env value into the command string — it goes through Exec's env instead",
  () =>
    Effect.gen(function* () {
      const calls: { command: string; env: Record<string, string | Redacted.Redacted<string>> }[] =
        [];
      const secret = Redacted.make("sk-super-secret-value");
      const desired: AiMcpServerDesired = {
        command: "npx",
        args: ["my-mcp-server"],
        env: { API_KEY: secret },
      };
      yield* CodexBackend.mcp!.apply("testserver", desired, ctxWith(capturingExec("", calls)));

      expect(calls).toHaveLength(1);
      expect(calls[0]!.command).not.toContain("sk-super-secret-value");
      expect(calls[0]!.command).toContain('"API_KEY=$MCP_SECRET_0"');
      expect(Redacted.value(calls[0]!.env.MCP_SECRET_0 as Redacted.Redacted<string>)).toBe(
        "sk-super-secret-value",
      );
    }),
);

it.effect(
  "apply fails with AiToolFieldUnsupported when asked for headers, which codex has no way to express",
  () =>
    Effect.gen(function* () {
      const desired: AiMcpServerDesired = {
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer x" },
      };
      const failure = yield* CodexBackend.mcp!.apply("x", desired, ctxWith(fakeExec(""))).pipe(
        Effect.flip,
      );
      expect(failure).toMatchObject({
        _tag: "AiToolFieldUnsupported",
        tool: "codex",
        field: "headers",
      });
    }),
);
