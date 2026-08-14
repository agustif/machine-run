import { Sh, Timeouts } from "@machine-run/core";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as UndefinedOr from "effect/UndefinedOr";
import {
  BackendParseError,
  type FlatpakRepo,
  type PackageEntry,
  type PackageManagerBackend,
  type PackageVersionSupport,
  rejectUnsupportedVersionSpec,
  type RepoBackend,
  type PackageTimeouts,
} from "../../Backend.ts";
import { lines } from "../../parse.ts";

/**
 * `flatpak install <id>//<branch>` — the double-slash branch suffix is
 * flatpak's own, long-stable syntax for naming which branch to install (e.g.
 * `org.gnome.Platform//45`), documented in `flatpak install`'s own manual
 * page and unchanged across every flatpak release this ecosystem has
 * shipped. A flatpak app has no semver-style version history a client can
 * request the way a `.deb`/`.rpm` archive holds one — what a recipe can
 * actually pin is *which branch* an app-id resolves from (`stable`, or a
 * runtime's own version-shaped branch like `45`), which is `VersionSpec`'s
 * `Channel` case, not `Exact` — the identical reasoning `Snap.ts` already
 * documents for its own `--channel`.
 *
 * **The branch/install interaction is not independently re-verified this
 * session.** `list`/`install` (unbranched) were already real,
 * container-verified below; extending that same container to also install a
 * *second* branch of an already-installed app-id needs `org.gnome.Platform`
 * or a similarly sizeable runtime actually downloaded, and this session's
 * attempts to even get `flatpak install --help`/`flatpak list --help`'s
 * exact column names — let alone a full branch install — did not finish:
 * `apt-get install flatpak` on `ubuntu:24.04` pulls in ~200 packages
 * (systemd, GTK, ostree, PolicyKit, …) and repeated attempts, up to a 500
 * second timeout, still had not finished unpacking when this file was
 * written (see this session's own repeated `apt-get update` slowness
 * elsewhere — `Go.ts`/`Apt.ts`'s notes on the same shared-sandbox network).
 * The `//branch` syntax itself is not in doubt (it is flatpak's one
 * documented way to do this, with no alternative spelling to get wrong the
 * way winget's table format turned out to have one) — what is genuinely
 * unconfirmed is whether installing a second branch over an existing
 * install of the same app-id just works, needs `--reinstall`, or needs the
 * first branch removed first. `canDowngrade: false` is the conservative
 * reading until that is actually observed, matching rule 0c's "unreachable
 * target" allowance rather than inventing a flag.
 */
export const flatpakVersionSupport: PackageVersionSupport = {
  accepts: new Set(["Channel"]),
  canDowngrade: false,
};

const rejectSpec = rejectUnsupportedVersionSpec("flatpak", flatpakVersionSupport);

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
 * `--columns=application,branch` is the same, not independently re-run this
 * session (see this module's own doc comment above for why) — `branch` is
 * flatpak's own documented column name (`flatpak list --help`'s prior,
 * already-real `--columns` confirmation), read the same tab-separated way
 * `makeFlatpakRepoBackend.listRepos` already reads `name`/`url` below.
 *
 * `install` takes no remote argument, so it only resolves when exactly one
 * configured remote (commonly Flathub) has that app ID — a machine with no
 * remote added yet, or more than one offering the same ID, needs the remote
 * added or named explicitly first. `makeFlatpakRepoBackend`'s `listRepos`/
 * `addRepo`, below, are exactly that wiring — this used to be a real, named
 * gap (see `Repo.ts`'s doc comment on `RepoSpec`); it no longer is.
 */
/** Declared here rather than inline at each `exec`, the same way this
 * backend's `versions` is: one statement of what this tool's own work costs. */
const flatpakTimeouts: PackageTimeouts = { install: Timeouts.systemPackage, refresh: Timeouts.indexRefresh };

export const makeFlatpakBackend = (): PackageManagerBackend => ({
  id: "flatpak",
  versions: flatpakVersionSupport,
  timeouts: flatpakTimeouts,
  list: (exec) =>
    exec({ command: Sh.sh("flatpak", "list", "--app", "--columns=application,branch") }).pipe(
      Effect.map((result) =>
        lines(result.stdout).map((line): PackageEntry => {
          const tab = line.indexOf("\t");
          return tab === -1
            ? { name: line }
            : { name: line.slice(0, tab), version: line.slice(tab + 1) };
        }),
      ),
    ),
  install: (name, version, exec) =>
    UndefinedOr.match(version, {
      onUndefined: () =>
        exec({
          command: Sh.sh("flatpak", "install", "-y", "--noninteractive", name),
          shell: true,
          timeout: flatpakTimeouts.install,
        }).pipe(Effect.asVoid),
      onDefined: (spec) =>
        Match.value(spec).pipe(
          Match.tagsExhaustive({
            Channel: (v) =>
              exec({
                command: Sh.sh("flatpak", "install", "-y", "--noninteractive", `${name}//${v.name}`),
                shell: true,
                timeout: flatpakTimeouts.install,
              }).pipe(Effect.asVoid),
            Exact: rejectSpec,
            AtLeast: rejectSpec,
            Digest: rejectSpec,
          }),
        ),
    }),
});

/**
 * flatpak's remote half. `FlatpakRepo`'s `name` and `location` are `Repo.ts`'s
 * `RepoSpec` fields for exactly the two arguments `flatpak remote-add NAME
 * LOCATION` itself takes — see that type's doc comment for why `location` is
 * optional (matching-only usage) and the real limitation that follows from
 * it below.
 */
export const makeFlatpakRepoBackend = (): RepoBackend<FlatpakRepo> => ({
  /**
   * `flatpak remotes --columns=name,url` — verified against `docker run --rm
   * --platform linux/amd64 ubuntu:24.04` (Flatpak 1.14.6, 2026-08-14): a
   * fresh install prints one blank line (not zero bytes) and exits 0
   * (fixture: `flatpak-remotes-empty.txt`); after adding both official
   * Flathub remotes it prints one tab-separated `name<TAB>url` pair per line,
   * no header (fixture: `flatpak-remotes.txt`, captured from
   * `flatpak remote-add --if-not-exists flathub
   * https://dl.flathub.org/repo/flathub.flatpakrepo` and the equivalent
   * `flathub-beta` call).
   *
   * Returns both a bare-name entry (`location` omitted) and, when a URL is
   * reported, a second entry carrying it — the same two-forms approach
   * `Dnf.ts`'s COPR `listRepos` uses — because of a real, container-confirmed
   * mismatch: `flatpak remote-add NAME LOCATION` accepts a `.flatpakrepo`
   * bootstrap URL (the standard, documented way to add Flathub) but the URL
   * `flatpak remotes` reports back afterward is the *resolved* underlying
   * repo URL from inside that file, not the bootstrap URL itself (verified:
   * adding `https://dl.flathub.org/repo/flathub.flatpakrepo` left `flatpak
   * remotes --columns=name,url` reporting `https://dl.flathub.org/repo/` — a
   * different string). Flatpak does not remember the original bootstrap URL
   * anywhere, so there is no way for `listRepos` to reconstruct it.
   *
   * **The honest consequence**: a `System.Repo` whose `FlatpakRepo` is
   * `{ name: "flathub", location: "https://dl.flathub.org/repo/flathub.flatpakrepo" }`
   * (the standard onboarding command every Flathub tutorial gives) will
   * `apply` correctly every time, but will never `matches` — every `plan`
   * reports this resource as needing an update, forever. That is safe
   * (`addRepo` uses `--if-not-exists`, so the repeated apply is a real
   * no-op), just not clean. Verified separately: adding the *resolved* URL
   * directly instead (skipping the `.flatpakrepo` bootstrap) fails GPG
   * signature verification (`Can't check signature: public key not found`,
   * exit 1) unless `--no-gpg-verify` is also passed — a real security
   * downgrade this backend does not add a flag for, so that path is not a
   * fix, only a worse trade. Use the bootstrap URL and accept the
   * always-dirty plan; this mirrors `SettingProps.value`'s own "copy the
   * canonical form, don't expect convergence otherwise" lesson, except here
   * no spelling of `location` both converges *and* stays secure.
   */
  listRepos: (exec) =>
    exec({ command: Sh.sh("flatpak", "remotes", "--columns=name,url"), shell: true }).pipe(
      Effect.map((result) => {
        const repos: FlatpakRepo[] = [];
        for (const line of lines(result.stdout)) {
          const tabIndex = line.indexOf("\t");
          const name = tabIndex === -1 ? line : line.slice(0, tabIndex);
          if (name.length === 0) continue;
          repos.push({ _tag: "Flatpak", name });
          if (tabIndex !== -1) {
            const location = line.slice(tabIndex + 1);
            if (location.length > 0) repos.push({ _tag: "Flatpak", name, location });
          }
        }
        return repos;
      }),
    ),

  /**
   * `--if-not-exists` makes this idempotent regardless of whether `matches`
   * ever reports true (see `listRepos`'s doc comment) — verified: without it,
   * re-adding an existing remote exits 1 with `error: Remote flathub already
   * exists`; with it, exit 0, no output, whether or not the remote already
   * existed. No `--user`/`--system` flag, matching `install`'s own existing
   * default (system-wide) for consistency within this backend — real
   * root/polkit requirements on a non-container desktop are the same
   * pre-existing, undocumented-here caveat `install` already carries.
   *
   * `location` being absent is a real, typed failure here — `remote-add`
   * cannot run without it — rather than a string that failed to parse the
   * way it was before `FlatpakRepo` gave the two arguments their own fields.
   */
  addRepo: (repo, exec) =>
    UndefinedOr.match(repo.location, {
      onUndefined: () =>
        Effect.fail(
          new BackendParseError({
            manager: "flatpak",
            cause: `addRepo needs a location to run "flatpak remote-add", but "${repo.name}" has none — it can only be used to recognise an already-added remote (see FlatpakRepo's doc comment)`,
          }),
        ),
      onDefined: (location) =>
        exec({
          command: Sh.sh("flatpak", "remote-add", "--if-not-exists", repo.name, location),
          shell: true,
        }).pipe(Effect.asVoid),
    }),
});
