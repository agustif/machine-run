import type { ShellBackend, ShellId } from "./Backend.ts";
import { BashBackend } from "./backends/Bash.ts";
import { FishBackend } from "./backends/Fish.ts";
import { NuBackend } from "./backends/Nu.ts";
import { PwshBackend } from "./backends/Pwsh.ts";
import { ZshBackend } from "./backends/Zsh.ts";

/**
 * The registry of shell backends, keyed by id — the same seam
 * `system-packages` and `secrets` use for their own backend families.
 * Adding a shell means writing `backends/<Name>.ts` and adding a line here;
 * `Profile.ts`'s composition functions never branch on `ShellId` themselves.
 */
export const shellBackends = {
  zsh: ZshBackend,
  bash: BashBackend,
  fish: FishBackend,
  nu: NuBackend,
  pwsh: PwshBackend,
} satisfies Record<ShellId, ShellBackend>;

export const shellBackend = (id: ShellId): ShellBackend => shellBackends[id];
