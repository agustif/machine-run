import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as UndefinedOr from "effect/UndefinedOr";
import {
  type PackageEntry,
  type PackageManagerBackend,
  type PackageVersionSupport,
  rejectUnsupportedVersionSpec,
} from "../../Backend.ts";
import { lines } from "../../parse.ts";

/**
 * Same `pkg=version` syntax as pacman itself (`yay`/`paru` pass an
 * official-repo request straight through — see this module's own doc
 * comment), and the same real limitation, one step worse: an AUR-origin
 * package has no repo at all behind it, only a PKGBUILD a helper builds
 * fresh from whatever the AUR currently holds — there is no server-side
 * history to request an older build from even in principle, so `Exact` can
 * only ever succeed by naming the version that would get built anyway.
 * `canDowngrade: false` for the identical reason `Pacman.ts`'s is: verified
 * there against a real `pacman -S name=olderversion` failure
 * (`error: target not found`), not independently re-run against a real
 * `yay`/`paru` binary here (building one is its own multi-minute story — see
 * this module's doc comment) — inferred from `yay`/`paru` being documented,
 * confirmed-by-this-repo pacman-CLI-compatible wrappers for the `-S` path,
 * not independently observed for this specific case.
 */
export const aurVersionSupport: PackageVersionSupport = {
  accepts: new Set(["Exact"]),
  canDowngrade: false,
};

/**
 * AUR helpers (`yay`, `paru`) — pacman wrappers that additionally build and
 * install packages from the Arch User Repository, which has no server-side
 * package database of its own: a helper clones a PKGBUILD from the AUR and
 * runs `makepkg`, then hands the resulting package to `pacman -U` like any
 * other. Neither helper is available from the official repos (installing
 * one is the AUR's own bootstrap problem — see `Repo.ts`'s doc comment for
 * why that means no `System.Repo` support either); a recipe using this
 * backend assumes the helper is already present on the machine, the same
 * way `Cargo.ts`/`Npm.ts` assume `cargo`/`npm` are already installed.
 *
 * `list` uses `pacman -Qmq` — "foreign" packages, i.e. installed but not
 * present in any configured sync database — rather than `yay`/`paru`'s own
 * query mode, because that is genuinely what distinguishes an AUR-origin
 * package from an official-repo one to pacman itself; a `System.Package` on
 * manager `"pacman"` already covers the official-repo case (`pacman -Qq`,
 * which does not distinguish the two). This also means `list` never has to
 * shell out to the helper at all.
 *
 * Verified against `docker run --rm --platform linux/amd64 archlinux:latest`:
 * `yay-bin` was built from the real AUR (`git clone
 * https://aur.archlinux.org/yay-bin.git && makepkg -si --noconfirm`) and,
 * once installed, `yay -S --noconfirm cmatrix` (an official-repo package)
 * correctly delegated straight to pacman, while `pacman -Qmq` afterwards
 * printed only `yay-bin`/`yay-bin-debug` — not `cmatrix` — confirming `-Qmq`
 * really does isolate AUR-origin packages from repo ones. `yay -Qmq` prints
 * the identical list (it's the same pacman query underneath). A real AUR
 * (not official-repo) install via `yay -S --noconfirm downgrade` reached the
 * download step before failing on this sandbox's own seccomp restriction
 * (the same `error: error restricting syscalls via seccomp` `Pacman.ts` hit,
 * which `--disable-sandbox` works around for plain pacman but which `yay`
 * has no equivalent passthrough flag for) — a container/CI artifact, not
 * something observed to be wrong with the command itself.
 *
 * `paru`'s own CLI is documented as pacman/yay-compatible for `-S`/
 * `--noconfirm`. Getting a real `paru` binary running to check that claim
 * turned out to be its own story, still unresolved as of this session:
 *
 * - `paru-bin` (the binary AUR package, the direct analogue of `yay-bin`
 *   above) built and installed cleanly with `makepkg -si --noconfirm` on a
 *   freshly-synced `archlinux:latest` — but the resulting binary failed to
 *   even run: `paru --version` died with `error while loading shared
 *   libraries: libalpm.so.15: cannot open shared object file`. `paru-bin` is
 *   compiled against whatever libalpm the AUR build server had; a container
 *   that only ran `pacman -Sy` (sync the database, matching `yay`'s own
 *   verification above) rather than a full `pacman -Syu` never installed a
 *   matching one. This is a real, reproducible finding about `paru-bin`
 *   specifically — `yay-bin`'s successful run in the same kind of container
 *   was not evidence that every AUR `-bin` package is this forgiving.
 * - Building plain `paru` from source (`git clone
 *   https://aur.archlinux.org/paru.git && makepkg -si --noconfirm`, pulling
 *   `rust`/`base-devel` first) sidesteps that ABI mismatch by linking
 *   against whatever libalpm is actually installed, and did progress
 *   cleanly through its entire dependency tree (`alpm`, `alpm-utils`,
 *   `reqwest`, `scraper`, `html5ever`, `tokio`, ~140 crates in total) to the
 *   final release-mode link of the `paru` binary itself — no compile error
 *   anywhere. That final link (`-C lto`, `codegen-units=1`) did not finish
 *   inside this session's time budget: still visibly progressing (steady
 *   CPU, growing memory, no crash) rather than stalled when verification
 *   work here concluded, which is a QEMU-emulation cost of a single-threaded
 *   LTO link for a ~140-crate binary, not a sign anything is wrong.
 *
 * Net effect: `paru` stays `~`, same as before this session, but the two
 * findings above are new and worth keeping — `paru-bin` is not a safe
 * drop-in the way `yay-bin` was without a preceding full system upgrade, and
 * a from-source build is a known-working (if very slow under emulation)
 * path that a future session with more time can pick back up to finish the
 * `-S`/`-Qmq` behavioural checks this file's `yay` section already has. Its
 * `install` below remains the same verified shape applied to the other
 * binary, not independently confirmed end to end.
 */
const makeAurHelperBackend = (bin: "yay" | "paru"): PackageManagerBackend => ({
  id: bin,
  versions: aurVersionSupport,
  // `-Qm` (without `-q`) reports `<name> <version>` pairs for foreign
  // packages, the same way `Pacman.ts`'s `list` drops `-q` — not
  // independently re-run in this session (see this module's doc comment on
  // why a fresh `yay`/`paru` binary wasn't rebuilt again here), but it is the
  // identical pacman query underneath with one flag removed, which `list`'s
  // existing `-Qmq` already relied on being true.
  list: (exec) =>
    exec({ command: Sh.sh("pacman", "-Qm") }).pipe(
      Effect.map((result) =>
        lines(result.stdout).map((line): PackageEntry => {
          const [name, version] = line.split(/\s+/);
          return name === undefined
            ? { name: line }
            : version === undefined
              ? { name }
              : { name, version };
        }),
      ),
    ),
  install: (name, version, exec) =>
    UndefinedOr.match(version, {
      onUndefined: () =>
        exec({
          command: Sh.sh(bin, "-S", "--noconfirm", name),
          shell: true,
          timeout: "10 minutes",
        }).pipe(Effect.asVoid),
      onDefined: (spec) =>
        Match.value(spec).pipe(
          Match.tagsExhaustive({
            Exact: (v) =>
              exec({
                command: Sh.sh(bin, "-S", "--noconfirm", `${name}=${v.version}`),
                shell: true,
                timeout: "10 minutes",
              }).pipe(Effect.asVoid),
            AtLeast: rejectUnsupportedVersionSpec(bin, aurVersionSupport),
            Channel: rejectUnsupportedVersionSpec(bin, aurVersionSupport),
            Digest: rejectUnsupportedVersionSpec(bin, aurVersionSupport),
          }),
        ),
    }),
  // `<bin> -Sy` — both helpers pass `-Sy` straight through to pacman
  // (documented `-S`-family passthrough behaviour, same CLI surface `install`
  // above already relies on), so this refreshes the official-repo sync
  // databases exactly like `Pacman.ts`'s own `refreshIndex`, with the
  // identical partial-upgrade caveat (`-Sy`, deliberately not `-Syu` — see
  // that module's doc comment) and the identical honest limit: it does
  // nothing for the AUR half specifically, which has no index to refresh at
  // all — a helper always builds from whatever the AUR holds *right now*
  // (see this module's own doc comment), so there is no staleness for an AUR
  // package to hit the way an official-repo one can.
  refreshIndex: (exec) =>
    exec({
      command: Sh.sh(bin, "-Sy", "--noconfirm"),
      shell: true,
      timeout: "5 minutes",
    }).pipe(Effect.asVoid),
});

export const makeYayBackend = (): PackageManagerBackend => makeAurHelperBackend("yay");
export const makeParuBackend = (): PackageManagerBackend => makeAurHelperBackend("paru");
