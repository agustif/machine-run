import { expect, it } from "@effect/vitest";
import { describeSecretSource, type SecretSource } from "../src/Backend.ts";

/**
 * `describeSecretSource` is the one place that renders a {@link SecretSource}
 * back into the single string a human would recognize as "the reference" —
 * every error message goes through it. These pin its output per variant so a
 * change to any backend's field names is caught here, not first noticed in a
 * confusing error message.
 */
it("renders a 1Password source as its op:// URI", () => {
  const source: SecretSource = {
    _tag: "OnePassword",
    vault: "Personal",
    item: "GitHub SSH Key",
    field: "private key",
  };
  expect(describeSecretSource(source)).toBe("op://Personal/GitHub SSH Key/private key");
});

it("renders a Doppler source as project/config/name", () => {
  const source: SecretSource = {
    _tag: "Doppler",
    project: "backend",
    config: "dev",
    name: "API_KEY",
  };
  expect(describeSecretSource(source)).toBe("backend/dev/API_KEY");
});

it("renders a Keychain source with an account as service/account", () => {
  const source: SecretSource = { _tag: "Keychain", service: "github", account: "agustif" };
  expect(describeSecretSource(source)).toBe("github/agustif");
});

it("renders a Keychain source with no account as just the service", () => {
  const source: SecretSource = { _tag: "Keychain", service: "github" };
  expect(describeSecretSource(source)).toBe("github");
});

it("renders a Pass source as its store path", () => {
  const source: SecretSource = { _tag: "Pass", path: "work/github/token" };
  expect(describeSecretSource(source)).toBe("work/github/token");
});

it("renders an Env source as its variable name", () => {
  const source: SecretSource = { _tag: "Env", variable: "GITHUB_TOKEN" };
  expect(describeSecretSource(source)).toBe("GITHUB_TOKEN");
});
