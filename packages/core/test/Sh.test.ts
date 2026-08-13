import { expect, it } from "@effect/vitest";
import { pwsh, quote, quotePwsh, ref, sh } from "../src/Sh.ts";

it("leaves shell-safe words unquoted", () => {
  expect(quote("ripgrep")).toBe("ripgrep");
  expect(quote("@scope/pkg")).toBe("@scope/pkg");
  expect(quote("com.apple.dock")).toBe("com.apple.dock");
});

it("quotes the empty string so it survives as an argument", () => {
  expect(quote("")).toBe("''");
  expect(sh("defaults", "write", "d", "k", "-string", "")).toBe(
    "defaults write d k -string ''",
  );
});

it("keeps a value containing spaces as a single argument", () => {
  expect(sh("brew", "install", "my pkg")).toBe("brew install 'my pkg'");
});

it("neutralises command substitution, chaining and redirection", () => {
  for (const payload of [
    "a; rm -rf /",
    "a && rm -rf /",
    "$(rm -rf /)",
    "`rm -rf /`",
    "a | tee /etc/passwd",
    "a > /etc/passwd",
    "$HOME",
  ]) {
    const rendered = quote(payload);
    expect(rendered.startsWith("'")).toBe(true);
    expect(rendered.endsWith("'")).toBe(true);
    // The payload survives verbatim inside the quotes, so the command still
    // receives the argument the caller meant — it just cannot be reinterpreted
    // by the shell.
    expect(rendered.slice(1, -1)).toBe(payload);
  }
});

it("escapes an embedded single quote without terminating the argument", () => {
  // POSIX has no escape inside single quotes, so quoting is closed, a
  // backslash-escaped quote is emitted, and quoting reopens: 'it' \' 's'.
  expect(quote("it's")).toBe(`'it'\\''s'`);
});

it("renders an env-var reference double-quoted so an empty value stays one argument", () => {
  expect(ref("TS_AUTHKEY")).toBe('"$TS_AUTHKEY"');
});

it("PowerShell quoting doubles an embedded single quote", () => {
  expect(quotePwsh("it's")).toBe("'it''s'");
});

it("PowerShell quoting is unconditional, because bare words depend on position", () => {
  // In argument position `/opt/mytool` is a string; in expression position
  // (`$x = /opt/mytool`) it parses as a command invocation and fails. A
  // quoting function cannot see which position its result lands in.
  expect(quotePwsh("/opt/mytool")).toBe("'/opt/mytool'");
  expect(quotePwsh("winget")).toBe("'winget'");
  expect(pwsh("winget", "install", "my pkg")).toBe("'winget' 'install' 'my pkg'");
});
