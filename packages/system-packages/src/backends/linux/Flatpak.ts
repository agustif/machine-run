import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import type { PackageManagerBackend } from "../../Backend.ts";
import { firstTokens, lines } from "../../parse.ts";

/**
 * `flatpak list --app --columns=application` restricts the listing to one
 * column — the application ID `flatpak install` itself takes — so each line
 * is exactly that ID with no other field to strip.
 *
 * Verified against `docker run --rm --platform linux/amd64 ubuntu:24.04`
 * (`apt-get install flatpak`, Flatpak 1.14.6): a fresh install's
 * `flatpak list --app --columns=application` printed nothing and exited 0,
 * and `flatpak list --help`/`flatpak install --help` confirmed `--columns`
 * takes `application` as a real column name and that `-y`/`--assumeyes`
 * plus `--noninteractive` are real non-interactive install flags. What
 * wasn't captured here: a *populated* listing's real line shape — every
 * flatpak app pulls a multi-hundred-MB runtime on first install
 * (`org.gnome.Platform` or similar), and that download didn't finish inside
 * this sandbox's time/network budget across several attempts. A
 * single-column request is unlikely to have hidden structure to misparse,
 * but that's inference from the documented behaviour, not a captured
 * fixture the way every other Linux backend here has one.
 *
 * `install` takes no remote argument, so it only resolves when exactly one
 * configured remote (commonly Flathub) has that app ID — a machine with no
 * remote added yet, or more than one offering the same ID, needs the remote
 * added or named explicitly first. There is no `System.Repo` wiring for
 * Flatpak remotes here; adding one is a real gap, not an intentional
 * decision the way pacman/AUR's absence is (see `Repo.ts`).
 */
export const makeFlatpakBackend = (): PackageManagerBackend => ({
  id: "flatpak",
  list: (exec) =>
    exec({ command: "flatpak list --app --columns=application" }).pipe(
      Effect.map((result) => firstTokens(lines(result.stdout))),
    ),
  install: (name, exec) =>
    exec({
      command: Sh.sh("flatpak", "install", "-y", "--noninteractive", name),
      shell: true,
      timeout: "10 minutes",
    }).pipe(Effect.asVoid),
});
