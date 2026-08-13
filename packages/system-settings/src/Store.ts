import type { SettingsBackend, SettingsBackendId } from "./Backend.ts";
import { DconfBackend } from "./backends/Dconf.ts";
import { GsettingsBackend } from "./backends/Gsettings.ts";

/**
 * The registry of settings-store backends, keyed by id.
 *
 * Mirrors `secrets/src/Store.ts` and `system-packages`' manager registry:
 * one generic resource, one lookup, one small module per store. Adding a
 * store means writing `backends/<Name>.ts` and adding a line here — no
 * resource changes, and no new resource type.
 */
export const settingsBackends = {
  gsettings: GsettingsBackend,
  dconf: DconfBackend,
} satisfies Record<SettingsBackendId, SettingsBackend>;

export const settingsBackend = (id: SettingsBackendId): SettingsBackend => settingsBackends[id];
