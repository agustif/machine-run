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

/**
 * `cargo install <crate> --version <x.y.z> --locked` — cargo's own,
 * long-stable pin flag (`cargo install --help` on cargo 1.97.1 documents
 * `--version` as "Specify a version to install"). Verified against
 * `docker run --rm rust:latest`:
 *
 * - **Pinning forward works.** `cargo install just --version 1.14.0 --locked`
 *   printed `Installed package `just v1.14.0` (executable `just`)`, and
 *   `just --version` then reported `just 1.14.0`.
 * - **A nonexistent version fails loudly**, rather than silently falling back
 *   to the latest candidate: `cargo install just --version 999.999.999
 *   --locked` exited `101` with `error: could not find `just` in registry
 *   `crates-io` with version `=999.999.999``.
 * - **Downgrading is not refused, and really does replace the binary.**
 *   Re-running `cargo install just --version 1.5.0 --locked` over the
 *   already-installed `1.14.0`, with **no `--force`**, exited `0` and printed
 *   cargo's own replacement lines verbatim:
 *   ```
 *   Replacing /usr/local/cargo/bin/just
 *    Replaced package `just v1.14.0` with `just v1.5.0` (executable `just`)
 *   ```
 *   `just --version` afterward reported `just 1.5.0`, and `cargo install
 *   --list` reported `just v1.5.0:` — so the older pin is what is on `$PATH`
 *   and what `list` (this backend's own `observe` path) reports. cargo
 *   neither refused the older target nor demanded a flag, unlike pacman's
 *   `-S name=olderversion` (`error: target not found`) and pipx's plain
 *   `install` (which refuses to touch an existing name at all).
 *
 * `canDowngrade: true` rests on that observed replacement plus crates.io
 * serving every published version forever (a yank still leaves an
 * explicitly-pinned version installable, with a warning rather than a hard
 * failure — seen in this same run: `warning: package `hermit-abi v0.3.1` in
 * Cargo.lock is yanked`).
 */
export const cargoVersionSupport: PackageVersionSupport = {
  accepts: new Set(["Exact"]),
  canDowngrade: true,
};

const rejectSpec = rejectUnsupportedVersionSpec("cargo", cargoVersionSupport);

/**
 * Verified against `docker run --rm rust:latest`: `cargo install --list`
 * printed nothing on a fresh image (confirming the empty case doesn't need
 * special-casing), then `cargo install just --locked` followed by
 * `cargo install ripgrep --locked` produced exactly
 * ```
 * just v1.58.0:
 *     just
 * ripgrep v15.2.0:
 *     rg
 * ```
 * — two unindented `<crate> v<version>:` headers, each followed by one
 * indented binary line. The header already carried a version before this
 * type existed; only the first token was ever kept. `PackageEntry.version`
 * now reports the same string cargo's own pin flag takes, with the leading
 * `v` stripped (`v1.58.0` → `1.58.0`) so it compares equal to a recipe's
 * `VersionSpec.Exact.version`, which is spelled the same way `--version`
 * itself takes it — without the `v` (fixture: `test/fixtures/cargo-install-list.txt`).
 */
export const parseCargoInstallList = (stdout: string): PackageEntry[] => {
  const entries: PackageEntry[] = [];
  for (const line of stdout.split("\n")) {
    // `cargo install --list` prints "name vX.Y.Z:" per crate, then indented
    // lines for that crate's installed binaries. Only the unindented lines
    // are crate headers — this filter must run on the *raw* line, before any
    // trimming, the same reasoning the pre-existing filter here already used.
    if (line.length === 0 || line.startsWith(" ")) continue;
    const match = /^(\S+)\s+v(\S+):$/.exec(line);
    if (match === null) continue;
    const name = match[1];
    const version = match[2];
    if (name === undefined) continue;
    entries.push(version === undefined ? { name } : { name, version });
  }
  return entries;
};

export const makeCargoBackend = (): PackageManagerBackend => ({
  id: "cargo",
  versions: cargoVersionSupport,
  list: (exec) =>
    exec({ command: Sh.sh("cargo", "install", "--list") }).pipe(
      Effect.map((result) => parseCargoInstallList(result.stdout)),
    ),
  install: (name, version, exec) =>
    UndefinedOr.match(version, {
      onUndefined: () =>
        exec({
          command: Sh.sh("cargo", "install", name),
          shell: true,
          timeout: "10 minutes",
        }).pipe(Effect.asVoid),
      onDefined: (spec) =>
        Match.value(spec).pipe(
          Match.tagsExhaustive({
            Exact: (v) =>
              exec({
                command: Sh.sh("cargo", "install", name, "--version", v.version),
                shell: true,
                timeout: "10 minutes",
              }).pipe(Effect.asVoid),
            AtLeast: rejectSpec,
            Channel: rejectSpec,
            Digest: rejectSpec,
          }),
        ),
    }),
});
