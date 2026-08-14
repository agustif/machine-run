import { DconfBackend } from "./backends/Dconf.ts";
import { GsettingsBackend } from "./backends/Gsettings.ts";

/**
 * The registry of settings-store backends. Mirrors `secrets/src/Store.ts`
 * and `system-packages`' manager registry: one generic resource, one small
 * module per store. Adding a store means writing `backends/<Name>.ts` and
 * adding a line here — no resource changes, and no new resource type.
 *
 * Unlike those two registries, there is no generic `settingsBackend(id)`
 * lookup function here: `GsettingsBackend` and `DconfBackend` take different
 * `Identity` types (`SettingsBackend<GsettingsIdentity |
 * GsettingsRelocatableIdentity>` vs `SettingsBackend<DconfIdentity>` — see
 * `Backend.ts`), so a lookup keyed by a runtime `SettingsBackendId` string
 * could only return them widened to a common shape, throwing away exactly
 * the typing this change exists to add. `Setting.ts` selects a backend by
 * matching `SettingProps`'s own `_tag` instead (`Match.tagsExhaustive`),
 * which keeps each branch's backend and its identity type paired.
 */
export const settingsBackends = {
  gsettings: GsettingsBackend,
  dconf: DconfBackend,
};
