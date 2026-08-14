import type { AiMcpServerDesired, AiToolContext } from "@machine-run/ai";
import { GrokBackend } from "@machine-run/ai";
import { CommandError, UnexpectedExit } from "alchemy/Command";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** Narrows a captured env value to `Redacted`, failing loudly if the test's own premise is wrong. */
const redactedEnvValue = (
  value: string | Redacted.Redacted<string> | undefined,
): Redacted.Redacted<string> =>
  Result.getOrThrow(
    Result.liftPredicate(
      value,
      (v): v is Redacted.Redacted<string> => v !== undefined && Redacted.isRedacted(v),
      () => "expected a captured env value to be Redacted, got a plain string or nothing",
    ),
  );

/** Renders a fixture as JSON text — `Schema.Json` rather than `JSON.stringify`. */
const toJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

const fakeExec =
  (stdout: string): AiToolContext["exec"] =>
  () =>
    Effect.succeed({ exitCode: 0, stdout, stderr: "" });

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

/**
 * Never touched by this backend, which shells out to `grok` directly rather
 * than reading its config file — real service values rather than a cast
 * through `unknown`, so a method this backend starts calling fails loudly
 * (`Effect.die`/a `PlatformError`) instead of silently returning `undefined`.
 */
const dieFs = FileSystem.makeNoop({});
const realPath = Effect.runSync(Path.Path.pipe(Effect.provide(Path.layer)));
const ctxWith = (exec: AiToolContext["exec"]): AiToolContext => ({
  exec,
  fs: dieFs,
  path: realPath,
  home: "/home/irrelevant",
});

/**
 * Real `grok mcp list --json` output, captured against an isolated `$HOME`
 * after `grok mcp add postgres -e DATABASE_URL=... -- npx -y
 * @modelcontextprotocol/server-postgres`. Grok has no `mcp get <name>`, so
 * this is the whole registry — the fixture includes a server this backend
 * is not asking about, exercising the by-name filter.
 */
const REAL_GROK_LIST = toJsonText([
  {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    env: { DATABASE_URL: "postgres://localhost/mydb" },
    enabled: true,
    name: "postgres",
    scope: "user",
  },
]);

/**
 * Real `grok mcp list --json` output for a remote server, captured against
 * an isolated `$HOME` inside a Docker container after `grok mcp add
 * --transport http sentry https://mcp.sentry.dev/mcp -H "Authorization:
 * Bearer secrettoken"`. `headers` really is present alongside `url` — an
 * earlier `GrokServer` schema had no field for it, so `observe` silently
 * dropped it; see this file's and `Grok.ts`'s doc comments.
 */
const REAL_GROK_LIST_REMOTE_WITH_HEADERS = toJsonText([
  {
    url: "https://mcp.sentry.dev/mcp",
    headers: { Authorization: "Bearer secrettoken" },
    enabled: true,
    name: "sentry",
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

it.effect("observe reports a remote server's headers, not just its url", () =>
  Effect.gen(function* () {
    const observed = yield* GrokBackend.mcp!.observe(
      "sentry",
      ctxWith(fakeExec(REAL_GROK_LIST_REMOTE_WITH_HEADERS)),
    );
    expect(observed).toEqual({
      url: "https://mcp.sentry.dev/mcp",
      headers: { Authorization: "Bearer secrettoken" },
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
    const failure = yield* GrokBackend.mcp!.observe("x", ctxWith(failingExec(error))).pipe(
      Effect.flip,
    );
    expect(failure).toMatchObject({ _tag: "AiToolCliMissing", tool: "grok" });
  }),
);

it.effect("remove runs `grok mcp remove <name> -s user`, scoped to the file this backend owns", () =>
  Effect.gen(function* () {
    const calls: { command: string; env: Record<string, string | Redacted.Redacted<string>> }[] =
      [];
    yield* GrokBackend.mcp!.remove("postgres", ctxWith(capturingExec("", calls)));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("grok mcp remove postgres -s user");
  }),
);

it.effect(
  "remove is a no-op for a name that isn't registered — grok's own exit-1 \"not found\" is absorbed",
  () =>
    Effect.gen(function* () {
      // Real, verified behaviour: `grok mcp remove doesnotexist -s user`
      // prints "No MCP server named 'doesnotexist' in user config" and exits
      // 1 — unlike codex, which exits 0 for the identical case.
      const error = new CommandError({
        command: "grok mcp remove doesnotexist -s user",
        reason: new UnexpectedExit({
          exitCode: 1,
          stderr: "No MCP server named 'doesnotexist' in user config",
        }),
      });
      yield* GrokBackend.mcp!.remove("doesnotexist", ctxWith(failingExec(error)));
    }),
);

it.effect("remove reports AiToolCliMissing when the grok binary itself is absent", () =>
  Effect.gen(function* () {
    const error = new CommandError({
      command: "grok mcp remove x -s user",
      reason: new UnexpectedExit({ exitCode: 127, stderr: "grok: command not found" }),
    });
    const failure = yield* GrokBackend.mcp!.remove("x", ctxWith(failingExec(error))).pipe(
      Effect.flip,
    );
    expect(failure).toMatchObject({ _tag: "AiToolCliMissing", tool: "grok" });
  }),
);

it.effect(
  "apply builds a stdio `grok mcp add` with a literal env value quoted in the command",
  () =>
    Effect.gen(function* () {
      const calls: { command: string; env: Record<string, string | Redacted.Redacted<string>> }[] =
        [];
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
      const calls: { command: string; env: Record<string, string | Redacted.Redacted<string>> }[] =
        [];
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
      expect(Redacted.value(redactedEnvValue(calls[0]!.env.MCP_SECRET_H0))).toBe(
        "Bearer sk-super-secret-value",
      );
    }),
);
