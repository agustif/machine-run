import { Sh } from "@machine-run/core";
import type { Exec, Reconciler } from "@machine-run/engine";
import { toProvider } from "@machine-run/engine";
import type { CommandError } from "alchemy/Command";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Changing a login shell is genuine machine state — unlike everything else
 * in this package, which only renders text into a `Dotfiles.ManagedBlock` —
 * so this is a real `Reconciler`, not a composition function.
 */
export const LoginProps = Schema.Struct({
  /**
   * Absolute path to the desired login shell, e.g. `/bin/zsh` or
   * `/opt/homebrew/bin/fish`. Not a `ShellId`: fish, nu and pwsh have no
   * fixed install location this package could infer (Homebrew, apt, cargo
   * and a manual build all land somewhere different), so the caller states
   * the exact path — the same way `SshHostProps.identityFile` is an explicit
   * path rather than something derived.
   */
  shell: Schema.String,
});

export type LoginProps = typeof LoginProps.Type;

/**
 * `previousShell` is bookkeeping, not desired state: it is never asked for
 * by props, only recorded by {@link makeLoginReconciler}'s `apply` from what
 * `observe` saw immediately beforehand, so {@link makeLoginReconciler}'s
 * `unapply` has something honest to restore. `matches` ignores it entirely —
 * see that reconciler's doc comment.
 */
export const LoginState = Schema.Struct({
  shell: Schema.String,
  previousShell: Schema.optionalKey(Schema.String),
});

export type LoginState = typeof LoginState.Type;

export interface Login extends Resource<"Shell.Login", LoginProps, LoginState> {}

export const Login = Resource<Login>("Shell.Login");

/**
 * Raised when `props.shell` is not listed in `/etc/shells`.
 *
 * `chsh` looks like it enforces this itself, and on some systems it does —
 * but verified in a container (Ubuntu 24.04's `chsh`, from `login-utils`):
 * run as **root**, it only warns ("Warning: /not/a/real/shell does not
 * exist") and still applies the change; run as the actual owning user (the
 * realistic case for a personal-machine reconciler, confirmed with a fresh
 * non-root user in the same container), it correctly refuses with exit code
 * 1. Relying on `chsh`'s own exit code alone would mean this resource's
 * correctness depends on which of those two paths a given system's `chsh`
 * takes — this checks `/etc/shells` itself first, so the failure is the same
 * typed error everywhere regardless of what the underlying `chsh` would have
 * done.
 */
export class ShellNotAllowed extends Data.TaggedError("ShellNotAllowed")<{
  shell: string;
  allowed: readonly string[];
}> {
  override get message() {
    return `"${this.shell}" is not listed in /etc/shells (${this.allowed.length > 0 ? this.allowed.join(", ") : "which is empty or unreadable"}). \`chsh\` restricts a non-superuser to a shell listed there — add it to /etc/shells yourself first (most package managers that install a shell do this automatically; a manually built binary usually does not).`;
  }
}

/**
 * Parses `/etc/shells`: one absolute path per line, blank lines and `#`
 * comments ignored. Verified against real captured output from both macOS
 * and Ubuntu 24.04 (`test/Login.test.ts` uses both verbatim) — the two agree
 * on this format even though their actual shell lists differ.
 */
export const parseEtcShells = (content: string): string[] =>
  content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

const currentUsername = (exec: Exec) =>
  exec({ command: Sh.sh("id", "-un"), shell: true }).pipe(
    Effect.map((result) => result.stdout.trim()),
  );

/**
 * The live login shell for `username`, dispatched by `process.platform` —
 * this is a fact about which directory-service tool exists on this OS, not
 * something to detect by probing, so it's decided the same way `detect.ts`
 * decides a package manager for a platform.
 *
 * macOS: `dscl . -read /Users/<user> UserShell` — verified directly on this
 * host (`dscl . -read /Users/<me> UserShell` read back `UserShell:
 * /bin/zsh`, matching `$SHELL`).
 *
 * Linux (and anything else `getent` covers, e.g. NIS/LDAP-backed systems):
 * `getent passwd <user>`, a colon-separated `passwd(5)` record whose 7th
 * field is the shell — verified in a container (Ubuntu 24.04):
 * `testuser:x:1001:1001::/home/testuser:/bin/sh`.
 */
const readLoginShell = (username: string, exec: Exec): Effect.Effect<string, CommandError> =>
  Match.value(process.platform).pipe(
    Match.when("darwin", () =>
      exec({
        command: Sh.sh("dscl", ".", "-read", `/Users/${username}`, "UserShell"),
        shell: true,
      }).pipe(Effect.map((result) => result.stdout.replace(/^UserShell:\s*/, "").trim())),
    ),
    Match.orElse(() =>
      exec({ command: Sh.sh("getent", "passwd", username), shell: true }).pipe(
        Effect.map((result) => result.stdout.trim().split(":")[6] ?? ""),
      ),
    ),
  );

/**
 * Builds the reconciler against an explicit `/etc/shells` path rather than a
 * hard-coded one, so a test can point it at a temp file instead of the real
 * machine's — `makeLoginReconciler` below is this with the real path filled
 * in, which is what `LoginProvider` actually registers.
 */
export const makeLoginReconcilerAt = (
  shellsPath: string,
): Effect.Effect<
  Reconciler<LoginProps, LoginState, CommandError | ShellNotAllowed>,
  never,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    // A missing /etc/shells reads as "nothing is allowed" rather than "nothing
    // constrains this" — the file's absence is itself unusual enough that the
    // safe default is to fail every shell's validation loudly, not to skip it.
    const allowedShells = () =>
      fs.readFileString(shellsPath).pipe(
        Effect.map(parseEtcShells),
        Effect.orElseSucceed((): string[] => []),
      );

    return {
      // One login shell per invoking user; this resource never targets
      // anyone else's account, so a single fixed address is enough to
      // serialise any two `Shell.Login` resources a recipe mistakenly
      // declares against each other, the same way `System.Package`'s
      // address is just the manager id.
      address: () => "shell-login",

      observe: (_props, ctx) =>
        Effect.gen(function* () {
          const username = yield* currentUsername(ctx.exec);
          const shell = yield* readLoginShell(username, ctx.exec);
          if (shell.length === 0) return Option.none();
          return Option.some({ shell });
        }),

      // Validated here, not only in `apply`: `diff` calls `desired` too, so
      // a recipe asking for a shell `/etc/shells` doesn't list fails at
      // `plan` time, before anything runs `chsh`.
      desired: (props) =>
        Effect.gen(function* () {
          const allowed = yield* allowedShells();
          if (!allowed.includes(props.shell)) {
            return yield* Effect.fail(new ShellNotAllowed({ shell: props.shell, allowed }));
          }
          return { shell: props.shell };
        }),

      // previousShell is bookkeeping `apply` fills in, not something `props`
      // ever asks for, so it takes no part in whether an observed state is
      // good enough — matching `Machine.File`'s treatment of an unset `mode`.
      matches: (observed, desired) => observed.shell === desired.shell,

      apply: ({ observed, desired }, ctx) =>
        Effect.gen(function* () {
          yield* ctx.exec({ command: Sh.sh("chsh", "-s", desired.shell), shell: true });
          return {
            shell: desired.shell,
            ...Option.match(observed, {
              onNone: () => ({}),
              onSome: (state) => ({ previousShell: state.shell }),
            }),
          };
        }),

      /**
       * Restores whatever shell was active immediately before the apply
       * that last changed it — the one piece of prior state this resource
       * actually captured (see `apply`, above), so this is an honest undo
       * rather than a fabricated one. If nothing was ever captured (this
       * resource adopted an existing shell and never actually changed it,
       * so `apply` never ran), there's nothing safe to restore and this is
       * a no-op, matching every other reconciler here that leaves `unapply`
       * unset when it has nothing genuine to reverse.
       */
      unapply: ({ recorded }, ctx) =>
        recorded.previousShell !== undefined
          ? ctx
              .exec({ command: Sh.sh("chsh", "-s", recorded.previousShell), shell: true })
              .pipe(Effect.asVoid)
          : Effect.void,
    };
  });

/** The reconciler `Shell.Login` actually registers, reading the real `/etc/shells`. */
export const makeLoginReconciler = makeLoginReconcilerAt("/etc/shells");

export const LoginProvider = () => toProvider(Login, makeLoginReconciler);
