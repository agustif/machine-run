import { Sh } from "@machine-run/core";
import type { Exec } from "@machine-run/engine";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { SecretRefInvalid } from "../src/Backend.ts";
import { readSecret } from "../src/Store.ts";

/**
 * `readSecret` is `Store.ts`'s one dispatch point: it narrows a
 * `SecretSource` by `_tag` and hands it to the one backend that understands
 * that shape. These pin two things per variant that the old
 * `secretBackends[props.source]` record lookup could never have gotten
 * wrong by construction (every backend shared one `read(ref: string, exec)`),
 * but that this rewrite's per-backend command construction genuinely could:
 * that dispatch reaches the right backend, and that the backend builds the
 * exact command its own doc comment claims from the split fields, not from
 * a re-joined string.
 */
const capturing = (calls: Array<string>, stdout: string): Exec => {
  const exec: Exec = (props) => {
    calls.push(props.command);
    return Effect.succeed({ exitCode: 0, stdout, stderr: "" });
  };
  return exec;
};

it.effect("routes OnePassword to `op read`, verbatim, over the assembled op:// URI", () =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const value = yield* readSecret(
      { _tag: "OnePassword", vault: "Personal", item: "GitHub SSH Key", field: "private key" },
      capturing(calls, "-----BEGIN...-----\n"),
    );
    expect(calls).toEqual([Sh.sh("op", "read", "op://Personal/GitHub SSH Key/private key")]);
    // No stripping: `op` is unverified, so whatever it prints is passed on as-is.
    expect(Redacted.value(value)).toBe("-----BEGIN...-----\n");
  }),
);

it.effect("routes Doppler to `doppler secrets get`, stripping its one trailing newline", () =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const value = yield* readSecret(
      { _tag: "Doppler", project: "backend", config: "dev", name: "API_KEY" },
      capturing(calls, "a-doppler-secret\n"),
    );
    expect(calls).toEqual([
      Sh.sh(
        "doppler",
        "secrets",
        "get",
        "API_KEY",
        "--plain",
        "--project",
        "backend",
        "--config",
        "dev",
      ),
    ]);
    expect(Redacted.value(value)).toBe("a-doppler-secret");
  }),
);

it.effect(
  "routes Keychain to `security find-generic-password -s`, with no `-a` when account is absent",
  () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      // `-g`, not `-w` — see src/backends/Keychain.ts for why. Real captured
      // `-g` shape for a plain printable value (test/fixtures/
      // keychain-g-flag-transcript.txt case 1).
      yield* readSecret(
        { _tag: "Keychain", service: "github" },
        capturing(calls, 'password: "token"\n'),
      );
      expect(calls).toEqual([Sh.sh("security", "find-generic-password", "-s", "github", "-g")]);
    }),
);

it.effect("routes Keychain to `-a` when an account is given", () =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    yield* readSecret(
      { _tag: "Keychain", service: "github", account: "agustif" },
      capturing(calls, 'password: "token"\n'),
    );
    expect(calls).toEqual([
      Sh.sh("security", "find-generic-password", "-s", "github", "-a", "agustif", "-g"),
    ]);
  }),
);

it.effect("routes Pass to `pass show`", () =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const value = yield* readSecret(
      { _tag: "Pass", path: "work/github/token" },
      capturing(calls, "sup3rsecret\n"),
    );
    expect(calls).toEqual([Sh.sh("pass", "show", "work/github/token")]);
    expect(Redacted.value(value)).toBe("sup3rsecret");
  }),
);

it.effect("routes Env to the process environment, never invoking `exec`", () =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const value = yield* readSecret(
      { _tag: "Env", variable: "GITHUB_TOKEN" },
      capturing(calls, "unused"),
    ).pipe(
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromEnvRecord({ GITHUB_TOKEN: "gh-token" })),
      ),
    );
    expect(calls).toEqual([]);
    expect(Redacted.value(value)).toBe("gh-token");
  }),
);

/**
 * `Env` is the one remaining place `SecretRefInvalid` still fires:
 * `Doppler` and `Keychain` used to parse a compound string ref at runtime
 * and could reject a malformed one, but their fields are now split at the
 * type level so there is nothing left to parse. `variable` is still a bare
 * `Schema.String`, though, so a name that isn't shell-identifier-shaped is
 * still only caught here, at read time — pinned so the regex in `Env.ts`
 * can't be quietly dropped.
 */
it.effect("rejects an Env variable name that isn't a valid identifier", () =>
  Effect.gen(function* () {
    const failure = yield* readSecret(
      { _tag: "Env", variable: "123-not-an-identifier" },
      capturing([], "unused"),
    ).pipe(Effect.flip);
    expect(failure).toBeInstanceOf(SecretRefInvalid);
    expect(failure).toMatchObject({ source: { _tag: "Env", variable: "123-not-an-identifier" } });
  }),
);
