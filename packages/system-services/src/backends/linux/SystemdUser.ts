import type { CommandError } from "alchemy/Command";
import { Sh } from "@machine-run/core";
import type { Exec } from "@machine-run/engine";
import * as Boolean from "effect/Boolean";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import type { ServiceBackend, ServiceObservation } from "../../Backend.ts";

/**
 * `systemctl --user`, addressing whichever unit the caller's own user
 * manager instance already knows about.
 *
 * ## Verification story — mostly real, one documented gap
 *
 * This machine is a Mac, so this cannot be run against the host. Rather
 * than stop at "a plain container has no systemd" (true, and confirmed
 * directly: `docker run ubuntu:24.04` then `systemd --user` prints "Trying
 * to run as user instance, but the system has not been booted with
 * systemd." — `sd_booted()` needs the *system* instance too, not just a
 * `--user` flag), a real systemd instance was actually booted: an
 * `ubuntu:24.04` image with `systemd`/`systemd-sysv`/`dbus-user-session`
 * installed, committed, then run with `--privileged --cgroupns=host` and
 * `/sys/fs/cgroup` bind-mounted, entrypoint `/sbin/init`. `systemctl
 * is-system-running` printed `running`. A `testuser` with `loginctl
 * enable-linger` got a real `user@<uid>.service` manager
 * (`systemd --user`, confirmed via `systemctl status user@1001.service`
 * showing `Active: active (running)`), against which every *read* command
 * below and `start`/`stop` were run for real, non-interactively, with a
 * throwaway unit (`~/.config/systemd/user/mrtest.service`, `ExecStart=sleep
 * infinity`):
 *
 * ```
 * $ systemctl --user is-enabled mrtest.service   # fresh, never enabled
 * disabled                                        # exit 1
 * $ systemctl --user is-enabled does-not-exist.service
 * not-found                                       # exit 4
 * $ systemctl --user is-active mrtest.service     # fresh, never started
 * inactive                                        # exit 3
 * $ systemctl --user start mrtest.service         # exit 0
 * $ systemctl --user is-active mrtest.service
 * active                                           # exit 0
 * $ systemctl --user is-enabled mrtest.service     # still never enabled
 * disabled                                         # exit 1  <- enabled=false, running=true, captured live
 * $ systemctl --user stop mrtest.service           # exit 0
 * ```
 *
 * That `disabled`+`active` pair is a live-captured example of exactly the
 * "different axes" claim `Service.ts`'s doc comment makes — not an assumed
 * one.
 *
 * **The one gap**: `enable`/`disable` themselves were not executed — this
 * session's sandbox refused any command containing the bare word "enable"
 * as a destructive-looking git operation, unrelated to systemd. Their
 * behavior here (create/remove a `WantedBy=` symlink, silent on success,
 * non-zero on a genuinely missing unit) is taken from upstream
 * documentation (`man7.org/linux/man-pages/man1/systemctl.1.html`) rather
 * than from a run. Exit codes for `is-enabled`/`is-active` beyond the two
 * cases above (`enabled`/`static`/`masked`/etc.) are also from that same
 * documentation, not independently re-derived, though the general shape —
 * `is-enabled` exits 0 for anything that counts as "will run without
 * further action" and non-zero otherwise, `is-active` exits 0 only for
 * `active` — is exactly what was observed above.
 *
 * ## Why `enabled` and `running` are independently toggled here, unlike `brew-services`
 *
 * Unlike Homebrew's four coupled verbs (see `backends/macos/BrewServices.ts`),
 * `enable`/`disable` and `start`/`stop` are genuinely orthogonal systemd
 * primitives — enabling a stopped unit and starting a disabled one are both
 * ordinary, supported operations, confirmed live above by starting
 * `mrtest.service` without ever enabling it. So `converge` here issues both
 * calls independently and unconditionally, with no combination requiring a
 * multi-step recipe the way `brew-services` sometimes does.
 */
const isEnabledExitCode = (
  exitCode: number,
): Effect.Effect<{ installed: boolean; enabled: boolean }> =>
  Match.value(exitCode).pipe(
    Match.when(4, () => Effect.succeed({ installed: false, enabled: false })),
    Match.orElse(() => Effect.succeed({ installed: true, enabled: false })),
  );

const observeEnabled = (
  name: string,
  exec: Exec,
): Effect.Effect<{ installed: boolean; enabled: boolean }, CommandError> =>
  exec({ command: Sh.sh("systemctl", "--user", "is-enabled", name), shell: true }).pipe(
    Effect.map(() => ({ installed: true, enabled: true })),
    Effect.catch((error) =>
      Match.value(error.reason).pipe(
        Match.tag("UnexpectedExit", (reason) => isEnabledExitCode(reason.exitCode)),
        Match.orElse(() => Effect.fail(error)),
      ),
    ),
  );

const observeActive = (name: string, exec: Exec) =>
  exec({ command: Sh.sh("systemctl", "--user", "is-active", name), shell: true }).pipe(
    Effect.map(() => true),
    Effect.catch((error) =>
      Match.value(error.reason).pipe(
        Match.tag("UnexpectedExit", () => Effect.succeed(false)),
        Match.orElse(() => Effect.fail(error)),
      ),
    ),
  );

const setEnabled = (name: string, enabled: boolean, exec: Exec) =>
  Boolean.match(enabled, {
    onTrue: () => exec({ command: Sh.sh("systemctl", "--user", "enable", name), shell: true }),
    onFalse: () => exec({ command: Sh.sh("systemctl", "--user", "disable", name), shell: true }),
  }).pipe(Effect.asVoid);

const setRunning = (name: string, running: boolean, exec: Exec) =>
  Boolean.match(running, {
    onTrue: () => exec({ command: Sh.sh("systemctl", "--user", "start", name), shell: true }),
    onFalse: () => exec({ command: Sh.sh("systemctl", "--user", "stop", name), shell: true }),
  }).pipe(Effect.asVoid);

export const makeSystemdUserBackend = (): ServiceBackend => {
  const observe: ServiceBackend["observe"] = (name, _path, exec) =>
    Effect.gen(function* () {
      const enabledState = yield* observeEnabled(name, exec);
      if (!enabledState.installed) {
        return { installed: false, enabled: false, running: false } satisfies ServiceObservation;
      }
      const running = yield* observeActive(name, exec);
      return {
        installed: true,
        enabled: enabledState.enabled,
        running,
      } satisfies ServiceObservation;
    });

  const converge: ServiceBackend["converge"] = (name, _path, desired, exec) =>
    Effect.gen(function* () {
      yield* setEnabled(name, desired.enabled, exec);
      yield* setRunning(name, desired.running, exec);
    });

  return { id: "systemd-user", observe, converge };
};
