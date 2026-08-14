import type { CommandRunProps } from "alchemy/Command";
import { expect, it } from "@effect/vitest";
import { CommandError, UnexpectedExit } from "alchemy/Command";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
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
import {
  makeTailscaleConnectionReconciler,
  TailscaleNotInstalled,
  type TailscaleConnectionProps,
} from "../src/Connection.ts";

const props: TailscaleConnectionProps = {
  authKey: { _tag: "Env", variable: "TS_KEY" },
};

const fakeExecOk = (stdout: string) => ({
  exec: () => Effect.succeed({ exitCode: 0, stdout, stderr: "" }),
});

const fakeExecFailing = (stderr: string, exitCode = 1) => ({
  exec: () =>
    Effect.fail(
      new CommandError({
        command: "tailscale status --json",
        reason: new UnexpectedExit({ exitCode, stderr }),
      }),
    ),
});

it.effect("observe reports absent when the daemon is stopped or logged out (nonzero exit)", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeTailscaleConnectionReconciler;
    // A real `tailscale status --json` exits non-zero with something like
    // "Tailscale is stopped." when the daemon isn't running — no mention of
    // "command not found"/"ENOENT", so this must not be classified as a
    // missing binary.
    const observed = yield* reconciler.observe(props, fakeExecFailing("Tailscale is stopped.\n"));
    expect(observed).toBeUndefined();
  }),
);

it.effect(
  "observe raises TailscaleNotInstalled, not absence, when the binary itself is missing",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeTailscaleConnectionReconciler;
      const error = yield* reconciler
        .observe(props, fakeExecFailing("tailscale: command not found", 127))
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(TailscaleNotInstalled);
    }),
);

it.effect("observe treats unparseable status JSON the same as not connected, not a crash", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeTailscaleConnectionReconciler;
    const observed = yield* reconciler.observe(props, fakeExecOk("not json at all"));
    expect(observed).toBeUndefined();
  }),
);

/**
 * BUG (see docs/test-findings.md): `observe` never actually looks at
 * `result.stdout`. It hands the *whole* `{exitCode, stdout, stderr}` object
 * straight to `decodeStatus`, which is `Schema.decodeUnknownEffect` over
 * `Schema.fromJsonString(...)` — a schema that only accepts a JSON *string*.
 * Handed an object instead, decoding always fails with a `SchemaError`, which
 * `observe` explicitly catches and turns into `undefined` ("treated the same
 * as not being connected"). So a genuinely-running, genuinely-authenticated
 * daemon is never detected: every `diff` reports drift and every `apply` runs
 * `tailscale up` again, unconditionally, on every single deploy.
 *
 * This test pins the *current* (broken) behaviour, valid JSON and all, rather
 * than asserting the intended one — the intended behaviour is asserted
 * against a directly-constructed `observed` value in the `apply` tests below,
 * which don't go through this code path.
 */
it.effect("observe reports the connected state, including hostname, for a live daemon", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeTailscaleConnectionReconciler;
    const observed = yield* reconciler.observe(
      props,
      fakeExecOk(
        Schema.encodeSync(Schema.fromJsonString(Schema.Json))({
          BackendState: "Running",
          Self: { HostName: "my-mac" },
        }),
      ),
    );
    // The status decoder takes the command's stdout, not the whole
    // `{ exitCode, stdout, stderr }` result. Handing it the result object
    // makes every decode fail, which this resource treats as "cannot
    // confirm it is running" — so a genuinely connected daemon would read
    // as absent and every apply would re-run `tailscale up`.
    expect(observed).toEqual({ hostname: "my-mac" });
  }),
);

it.effect("matches: a recipe that doesn't pin a hostname is satisfied by whatever is live", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeTailscaleConnectionReconciler;
    const desired = yield* reconciler.desired(props);
    expect(reconciler.matches({ hostname: "whatever-the-tailnet-picked" }, desired)).toBe(true);
  }),
);

it.effect("matches: a pinned hostname that differs from the live one is real drift", () =>
  Effect.gen(function* () {
    const reconciler = yield* makeTailscaleConnectionReconciler;
    const desired = yield* reconciler.desired({ ...props, hostname: "pinned-name" });
    expect(reconciler.matches({ hostname: "other-name" }, desired)).toBe(false);
    expect(reconciler.matches({ hostname: "pinned-name" }, desired)).toBe(true);
  }),
);

it.effect(
  "apply, when not yet connected, reads the auth key from its backend and passes it via env — never interpolated into the command string",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeTailscaleConnectionReconciler;
      const seen: CommandRunProps[] = [];
      const capturingExec = {
        exec: (p: CommandRunProps) => {
          seen.push(p);
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        },
        snapshot: () => Effect.succeed(undefined),
      };

      const desired = yield* reconciler.desired(props);
      yield* reconciler
        .apply({ props, observed: undefined, desired }, capturingExec)
        .pipe(
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromEnvRecord({ TS_KEY: "tskey-secret-value" })),
          ),
        );

      expect(seen).toHaveLength(1);
      expect(seen[0]!.command).not.toContain("tskey-secret-value");
      expect(seen[0]!.command).toContain("$TS_AUTHKEY");
      const authKey = seen[0]!.env?.TS_AUTHKEY;
      expect(authKey).toBeDefined();
      expect(Redacted.value(redactedEnvValue(authKey))).toBe("tskey-secret-value");
    }),
);

it.effect(
  "apply, when already connected (a correctly-populated `observed`), only moves the hostname — it never re-authenticates",
  () =>
    Effect.gen(function* () {
      const reconciler = yield* makeTailscaleConnectionReconciler;
      const seen: string[] = [];
      const capturingExec = {
        exec: (p: { command: string }) => {
          seen.push(p.command);
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        },
        snapshot: () => Effect.succeed(undefined),
      };

      const desired = yield* reconciler.desired({ ...props, hostname: "new-name" });
      yield* reconciler.apply(
        { props: { ...props, hostname: "new-name" }, observed: { hostname: "old-name" }, desired },
        capturingExec,
      );

      expect(seen).toHaveLength(1);
      expect(seen[0]).not.toContain("tailscale up");
      expect(seen[0]).toContain("tailscale set");
    }),
);
