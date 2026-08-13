import * as SystemServices from "@machine-run/system-services";
import * as Effect from "effect/Effect";

/**
 * `System.Service` across `launchd`, `systemd-user` and `brew-services`.
 *
 * `enabled` (will act on its own next chance it gets) and `running` (has a
 * live instance right now) are tracked separately, because real service
 * managers keep them separate too — Homebrew's own `kill`/`run` verbs exist
 * specifically to reach `enabled: true, running: false` and
 * `enabled: false, running: true` on purpose, not by drift. See
 * `@machine-run/system-services`'s `Service.ts` for the full reasoning.
 *
 * **Not yet folded into `@machine-run/machine`'s aggregate `providers()`.**
 * This package was added without touching `packages/machine` (a deliberate
 * scope boundary for the change that introduced it — the orchestrator
 * layer's own completeness is a separate decision). `alchemy.run.ts` merges
 * `SystemServices.providers()` in directly instead, which is why this
 * compiles and type-checks against the stack's real provider set rather than
 * only *looking* wired up — see `docs/TASKS.md` for folding it into the
 * aggregate itself.
 */
export const services = Effect.gen(function* () {
  // A hand-authored LaunchAgent: the plist itself would be written by
  // `Machine.File` elsewhere (`@machine-run/dotfiles`) at the conventional
  // `~/Library/LaunchAgents/<name>.plist`; this resource only converges
  // whether launchd has it loaded and running.
  yield* SystemServices.Service("backup-agent", {
    backend: "launchd",
    name: "com.example.backup-agent",
  });

  // Registered to launch at login, but deliberately not started right now —
  // the `enabled: true, running: false` state Homebrew's own `kill` verb
  // exists to reach.
  yield* SystemServices.Service("transmission-daemon", {
    backend: "brew-services",
    name: "transmission-cli",
    running: false,
  });

  // A systemd user unit, addressed by its full unit name.
  yield* SystemServices.Service("sync-daemon", {
    backend: "systemd-user",
    name: "syncthing.service",
  });
});
