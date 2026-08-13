import { expect, it } from "@effect/vitest";
import { shellBackend } from "../src/Store.ts";

/**
 * Expected output below is hand-derived from the exact mechanisms verified
 * in a container (see `docs/shell-notes.md` for the commands run and their
 * real output) — zsh's `chpwd_functions`, bash's dedupe-guarded
 * `PROMPT_COMMAND`, fish's `--on-variable PWD` plus its `'...\'...'`
 * single-quote escaping, nu's compose-not-replace `hooks.env_change.PWD`
 * plus its `r#'...'#` raw strings, and PowerShell's
 * `LocationChangedAction`. These are not tautological: each assertion is the
 * real shell syntax that mechanism needs, not a copy of whatever the
 * renderer happens to emit.
 */

const HOOK_PROPS = {
  name: "gh_personal",
  pathGlob: "/Users/a/work/*",
  command: "gh auth switch --user me",
};

it("zsh renders export/alias with Sh.quote and a case-glob PATH guard", () => {
  const zsh = shellBackend("zsh");
  expect(zsh.rcPath).toBe("~/.zshrc");
  expect(zsh.commentPrefix).toBe("#");
  expect(zsh.renderEnvVar("FOO", "bar baz")).toBe(`export FOO='bar baz'`);
  expect(zsh.renderAlias("ll", "ls -la")).toBe(`alias ll='ls -la'`);
  expect(zsh.renderPathEntry("/opt/mytool")).toBe(
    [
      `case ":$PATH:" in`,
      `  *":/opt/mytool:"*) ;;`,
      `  *) export PATH="/opt/mytool:$PATH" ;;`,
      "esac",
    ].join("\n"),
  );
});

it("zsh renders a POSIX function — verified in a container that $1/$2/$@ read back the caller's arguments", () => {
  const zsh = shellBackend("zsh");
  expect(zsh.renderFunction("greet", 'echo "hello $1 and $2"')).toBe(
    ["greet() {", '  echo "hello $1 and $2"', "}"].join("\n"),
  );
});

it("zsh renders a chpwd_functions hook wrapping a case/esac glob dispatch", () => {
  const zsh = shellBackend("zsh");
  expect(zsh.renderHook(HOOK_PROPS)).toBe(
    [
      "_machine_run_gh_personal() {",
      `  case "$PWD" in`,
      `    /Users/a/work/*) gh auth switch --user me ;;`,
      "  esac",
      "}",
      "chpwd_functions+=(_machine_run_gh_personal)",
    ].join("\n"),
  );
});

it("bash shares zsh's POSIX env/alias/PATH rendering", () => {
  const bash = shellBackend("bash");
  expect(bash.rcPath).toBe("~/.bashrc");
  expect(bash.renderEnvVar("FOO", "bar baz")).toBe(`export FOO='bar baz'`);
  expect(bash.renderAlias("ll", "ls -la")).toBe(`alias ll='ls -la'`);
});

it("bash shares zsh's POSIX function rendering", () => {
  const bash = shellBackend("bash");
  expect(bash.renderFunction("greet", 'echo "hello $1 and $2"')).toBe(
    ["greet() {", '  echo "hello $1 and $2"', "}"].join("\n"),
  );
});

it("bash renders a dedupe-guarded PROMPT_COMMAND hook — verified to fire once per directory, not once per prompt", () => {
  const bash = shellBackend("bash");
  expect(bash.renderHook(HOOK_PROPS)).toBe(
    [
      `_machine_run_gh_personal_prev_pwd=""`,
      "_machine_run_gh_personal() {",
      `  if [ "$PWD" != "$_machine_run_gh_personal_prev_pwd" ]; then`,
      `    _machine_run_gh_personal_prev_pwd="$PWD"`,
      `    case "$PWD" in`,
      `      /Users/a/work/*) gh auth switch --user me ;;`,
      "    esac",
      "  fi",
      "}",
      `PROMPT_COMMAND="_machine_run_gh_personal\${PROMPT_COMMAND:+; $PROMPT_COMMAND}"`,
    ].join("\n"),
  );
});

it("bash declares a loginRc that sources .profile then .bashrc, so a login shell converges too", () => {
  const bash = shellBackend("bash");
  expect(bash.loginRc?.path).toBe("~/.bash_profile");
  expect(bash.loginRc?.render("~/.bashrc")).toBe(
    [
      `if [ -f "$HOME/.profile" ]; then . "$HOME/.profile"; fi`,
      `if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi`,
    ].join("\n"),
  );
});

it("zsh has no loginRc — every interactive zsh session already reads .zshrc", () => {
  expect(shellBackend("zsh").loginRc).toBeUndefined();
});

it("fish renders set -gx / alias with its own single-quote escaping", () => {
  const fish = shellBackend("fish");
  expect(fish.rcPath).toBe("~/.config/fish/config.fish");
  expect(fish.renderEnvVar("FOO", "it's")).toBe(`set -gx FOO 'it\\'s'`);
  expect(fish.renderAlias("ll", "ls -la")).toBe(`alias ll 'ls -la'`);
});

it("fish renders a contains-guarded PATH prepend — verified to dedupe (adding the same dir twice left one entry)", () => {
  const fish = shellBackend("fish");
  expect(fish.renderPathEntry("/opt/mytool")).toBe(
    ["if not contains -- '/opt/mytool' $PATH", "    set -gx PATH '/opt/mytool' $PATH", "end"].join(
      "\n",
    ),
  );
});

it("fish renders a function with argv, indented — verified in a container that $argv[1]/$argv[2] and $argv itself read back", () => {
  const fish = shellBackend("fish");
  expect(fish.renderFunction("greet", "echo hello $argv[1] and $argv[2]")).toBe(
    ["function greet", "    echo hello $argv[1] and $argv[2]", "end"].join("\n"),
  );
});

it("fish renders an --on-variable PWD hook with a switch/case glob dispatch", () => {
  const fish = shellBackend("fish");
  expect(fish.renderHook(HOOK_PROPS)).toBe(
    [
      "function _machine_run_gh_personal --on-variable PWD",
      "    switch $PWD",
      "        case '/Users/a/work/*'",
      "            gh auth switch --user me",
      "    end",
      "end",
    ].join("\n"),
  );
});

it("nu renders env vars and PATH entries with raw-string quoting", () => {
  const nu = shellBackend("nu");
  expect(nu.rcPath).toBe("~/.config/nushell/config.nu");
  expect(nu.renderEnvVar("FOO", "bar baz")).toBe(`$env.FOO = r#'bar baz'#`);
  expect(nu.renderPathEntry("/opt/mytool")).toBe(
    `$env.PATH = ($env.PATH | prepend r#'/opt/mytool'# | uniq)`,
  );
});

it("nu's alias takes a bare pipeline, not a quoted string — a real, documented difference from every other shell here", () => {
  expect(shellBackend("nu").renderAlias("ll", "ls -la")).toBe("alias ll = ls -la");
});

it("nu renders a def with declared positional params — verified in a container that greet Alice Bob reads them back", () => {
  const nu = shellBackend("nu");
  expect(nu.renderFunction("greet", '$"hello ($a) and ($b)"', ["a", "b"])).toBe(
    ["def greet [a, b] {", '    $"hello ($a) and ($b)"', "}"].join("\n"),
  );
});

it("nu renders a zero-parameter def when params is omitted", () => {
  const nu = shellBackend("nu");
  expect(nu.renderFunction("hello", '"hi"')).toBe(["def hello [] {", '    "hi"', "}"].join("\n"));
});

it("nu renders a variadic def when params carries a ...rest spread — verified in a container that greetall a b c reads all three back", () => {
  const nu = shellBackend("nu");
  expect(nu.renderFunction("greetall", '$"all: ($rest | str join \' \')"', ["...rest"])).toBe(
    ["def greetall [...rest] {", "    $\"all: ($rest | str join ' ')\"", "}"].join("\n"),
  );
});

it("nu renders a compose-not-replace env_change.PWD hook with a str starts-with prefix check", () => {
  const nu = shellBackend("nu");
  expect(nu.renderHook(HOOK_PROPS)).toBe(
    [
      "# _machine_run_gh_personal",
      "$env.config = ($env.config | upsert hooks.env_change.PWD (",
      "    ($env.config.hooks.env_change.PWD? | default []) | append {|before, after|",
      `        if ($after | str starts-with r#'/Users/a/work'#) {`,
      "            gh auth switch --user me",
      "        }",
      "    }",
      "))",
    ].join("\n"),
  );
});

it("pwsh renders $env: assignment and a function-as-alias", () => {
  const pwsh = shellBackend("pwsh");
  expect(pwsh.rcPath).toBe("~/.config/powershell/Microsoft.PowerShell_profile.ps1");
  expect(pwsh.renderEnvVar("FOO", "bar baz")).toBe(`$env:FOO = 'bar baz'`);
  expect(pwsh.renderAlias("ll", "ls -la")).toBe("function ll { & ls -la @args }");
});

it("pwsh renders a function reading $args, not a forwarding-to-another-command alias", () => {
  const pwsh = shellBackend("pwsh");
  expect(pwsh.renderFunction("greet", '"$($args[0]) and $($args[1])"')).toBe(
    ["function greet {", '    "$($args[0]) and $($args[1])"', "}"].join("\n"),
  );
});

it("pwsh renders a PathSeparator-split PATH guard, not a POSIX colon-split one", () => {
  const pwsh = shellBackend("pwsh");
  expect(pwsh.renderPathEntry("/opt/mytool")).toBe(
    [
      `if (($env:PATH -split [IO.Path]::PathSeparator) -notcontains '/opt/mytool') {`,
      `    $env:PATH = '/opt/mytool' + [IO.Path]::PathSeparator + $env:PATH`,
      "}",
    ].join("\n"),
  );
});

it("pwsh renders a LocationChangedAction hook with -like glob matching — verified live to fire on Set-Location", () => {
  const pwsh = shellBackend("pwsh");
  expect(pwsh.renderHook(HOOK_PROPS)).toBe(
    [
      "$_machine_run_gh_personal = {",
      "    param($sender, $eventArgs)",
      `    if ($eventArgs.NewPath.Path -like '/Users/a/work/*') {`,
      "        gh auth switch --user me",
      "    }",
      "}",
      "$ExecutionContext.SessionState.InvokeCommand.LocationChangedAction = $_machine_run_gh_personal",
    ].join("\n"),
  );
});
