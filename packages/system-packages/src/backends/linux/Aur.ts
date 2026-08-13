import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import type { PackageManagerBackend } from "../../Backend.ts";
import { lines } from "../../parse.ts";

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
 * `--noconfirm`, but it was not itself built and run here (yay already
 * demonstrated the AUR-build bootstrap and the `-Qmq` behaviour this backend
 * depends on); its `install` below is the same verified shape applied to the
 * other binary, not independently confirmed.
 */
const makeAurHelperBackend = (bin: "yay" | "paru"): PackageManagerBackend => ({
  id: bin,
  list: (exec) =>
    exec({ command: "pacman -Qmq" }).pipe(Effect.map((result) => lines(result.stdout))),
  install: (name, exec) =>
    exec({
      command: Sh.sh(bin, "-S", "--noconfirm", name),
      shell: true,
      timeout: "10 minutes",
    }).pipe(Effect.asVoid),
});

export const makeYayBackend = (): PackageManagerBackend => makeAurHelperBackend("yay");
export const makeParuBackend = (): PackageManagerBackend => makeAurHelperBackend("paru");
