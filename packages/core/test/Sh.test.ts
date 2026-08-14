import { expect, it } from "@effect/vitest";
import type { ShellCommand } from "../src/Sh.ts";
import { pipe, pwsh, quote, quotePwsh, ref, sh, unsafeRaw } from "../src/Sh.ts";

/**
 * `ShellCommand` exists so a command string built by ordinary template-literal
 * interpolation cannot be handed to anything that expects the output of
 * `sh`/`pwsh` quoting — see 0.6 and 2.5 in `MUST_CLEANUP.md`. This is a
 * compile-time guard: reverting `ShellCommand` to a bare `string` (its shape
 * before branding) makes the `@ts-expect-error` below stop being an error,
 * which is exactly the regression it exists to catch.
 */
// @ts-expect-error -- a plain template literal is a `string`, not a `ShellCommand`.
const _rawStringIsNotAShellCommand: ShellCommand = `rm -rf ${"whatever"}`;

it("leaves shell-safe words unquoted", () => {
  expect(quote("ripgrep")).toBe("ripgrep");
  expect(quote("@scope/pkg")).toBe("@scope/pkg");
  expect(quote("com.apple.dock")).toBe("com.apple.dock");
});

it("quotes the empty string so it survives as an argument", () => {
  expect(quote("")).toBe("''");
  expect(sh("defaults", "write", "d", "k", "-string", "")).toBe("defaults write d k -string ''");
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

it("sh and pwsh both return a usable ShellCommand", () => {
  // The runtime value is still a plain string underneath the brand; only the
  // type changes. Assigning to the `ShellCommand`-typed binding is itself
  // part of what's being checked — a bare `string` return would still pass
  // the `.toBe` assertion but would not satisfy this annotation.
  const posix: ShellCommand = sh("brew", "install", "ripgrep");
  const windows: ShellCommand = pwsh("choco", "install", "ripgrep");
  expect(posix).toBe("brew install ripgrep");
  expect(windows).toBe("'choco' 'install' 'ripgrep'");
});

it("pipe joins two ShellCommands with a POSIX pipe", () => {
  const piped: ShellCommand = pipe(
    sh("defaults", "export", "com.apple.dock", "-"),
    sh("plutil", "-extract", "tilesize", "xml1", "-o", "-", "-"),
  );
  expect(piped).toBe("defaults export com.apple.dock - | plutil -extract tilesize xml1 -o - -");
});

it("pipe cannot be confused with a value carrying its own literal '|'", () => {
  // A hostile value survives `quote` inside its own single quotes, so the
  // `|` this test asserts on is unambiguously the pipe `pipe` inserted, not
  // one smuggled in through either side's own argument.
  const piped = pipe(sh("echo", "a | rm -rf /"), sh("cat"));
  expect(piped).toBe("echo 'a | rm -rf /' | cat");
});

it("unsafeRaw builds a ShellCommand from an unquoted string, for the two documented escape hatches", () => {
  const command: ShellCommand = unsafeRaw(
    "echo $HOME && whoami",
    "Machine.Exec runs operator-authored shell by design",
  );
  // `reason` is documentation for the call site, not part of the command.
  expect(command).toBe("echo $HOME && whoami");
});
