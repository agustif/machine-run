import { Sh, Timeouts } from "@machine-run/core";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as UndefinedOr from "effect/UndefinedOr";
import {
  type PackageEntry,
  type PackageManagerBackend,
  type PackageVersionSupport,
  rejectUnsupportedVersionSpec,
  type PackageTimeouts,
} from "../../Backend.ts";

/**
 * `go install <path>@<version>` — verified against `docker run --rm
 * golang:1.23`: `go install golang.org/x/tools/cmd/goimports@v99.99.99`
 * failed with `go: golang.org/x/tools/cmd/goimports@v99.99.99: invalid
 * version: unknown revision cmd/goimports/v99.99.99`, a real, typed
 * "no such version" answer from the module proxy rather than a generic
 * failure. This session's own attempt at the paired success case (`@v0.30.0`)
 * hit outbound-network flakiness twice (`TLS handshake timeout` talking to
 * `proxy.golang.org`) — a separate, parallel verification pass against the
 * same image did not reproduce that timeout at all, so it was transient to
 * this session's own attempts, not a property of the `golang:1.23` image or
 * of `go install` itself.
 *
 * `canDowngrade: true` is now an **observed** fact, not only inferred from
 * `GOPROXY`'s immutability guarantee: that same parallel pass installed
 * `goimports@v0.20.0`, then re-ran `go install
 * golang.org/x/tools/cmd/goimports@v0.19.0` over it, and confirmed via
 * `go version -m` that the binary's embedded `mod` line moved backward to
 * `v0.19.0` — a real downgrade, accepted with no special flag the way
 * pacman's `-S name=olderversion` and pipx's plain `install` both refuse
 * without one. Immutable proxy caching explains *why* the older artifact is
 * always still fetchable; this is the separate, now-confirmed fact that
 * `go install` itself does not additionally refuse to move backward.
 */
export const goVersionSupport: PackageVersionSupport = {
  accepts: new Set(["Exact"]),
  canDowngrade: true,
};

const rejectSpec = rejectUnsupportedVersionSpec("go-install", goVersionSupport);

/**
 * `go install` has no listing command of its own — there is no `go list
 * installed` for globally-installed binaries (`go help install`, checked
 * locally, documents only what it builds and where it places the result:
 * `$GOBIN`, or `$GOPATH/bin`/`$HOME/go/bin` if unset). The only inventory is
 * the directory itself, and a directory listing alone isn't enough: the
 * binary's filename is the *last path segment* of the package it was built
 * from (`golang.org/x/tools/cmd/goimports` → `goimports`), so a bare
 * filename can't be compared against `props.name`, which has to be the full
 * import path — that's the only thing `go install` itself accepts, and
 * losing it would make `install` unable to reinstall a package `observe`
 * reported as missing.
 *
 * `go version -m <path>` embeds exactly that path back out of the compiled
 * binary itself, on a line shaped `\tpath\t<import path>`, immediately
 * followed by a `\tmod\t<module path>\t<version>\th1:…` line naming the
 * *enclosing module's* path and the concrete version that was actually
 * built — this is standard Go build-info embedding, not something scraped
 * from a filename. Running it once over every file in the bin directory
 * (`go version -m dir/*`) avoids one shell-out per installed binary.
 *
 * Verified locally (macOS, go 1.26.5, installed via `brew install go`):
 * `go install golang.org/x/tools/cmd/goimports@latest` placed a binary at
 * `$(go env GOPATH)/bin/goimports`, and
 * `go version -m "$(go env GOPATH)/bin"/*` printed (among build-info lines
 * this ignores):
 * ```
 * /Users/…/go/bin/goimports: go1.26.5
 * 	path	golang.org/x/tools/cmd/goimports
 * 	mod	golang.org/x/tools	v0.48.0	h1:…
 * ```
 * `path`'s value (`golang.org/x/tools/cmd/goimports`) is what `install`
 * accepts and what `PackageEntry.name` reports — the same full import path
 * as before this field existed. `mod`'s value is the *module root*
 * (`golang.org/x/tools`, one level up from the specific command package)
 * and its version (`v0.48.0`) — not the same string as `path`, but the only
 * version go's own build info actually records for that binary, so this is
 * reported as `PackageEntry.version` regardless of the path/mod prefix
 * mismatch; `matches` in `Package.ts` compares this against a recipe's own
 * `VersionSpec.Exact.version`, which for `go-install` is expected to be
 * spelled the same way (`v0.48.0`, not `0.48.0` — go's own tag format,
 * verified above).
 *
 * With an empty or nonexistent bin directory, the unquoted glob doesn't
 * expand and `go version -m` fails on the literal `*` — `2>/dev/null; true`
 * discards that stderr and forces exit 0 (verified: empty stdout, exit 0),
 * the same idiom `Apt.ts`'s `listRepos` uses for its own optional globs.
 *
 * Independently reverified against `docker run --rm golang:1.23` (go
 * 1.23.12, linux/arm64): the exact `list` command above printed nothing
 * against an empty `$GOPATH/bin` (confirming the `2>/dev/null; true` empty
 * case, not just the "verified locally" claim above), and after installing
 * two binaries printed both `path`/`mod`/`dep` blocks back to back —
 * `parseGoVersionM` correctly pulled just the two import paths out of a
 * multi-binary block (fixture: `test/fixtures/go-version-m.txt` — captured
 * before `mod` was read; the `path`-only shape there is unchanged, only the
 * parser now also reads the `mod` line beneath it).
 */
export const parseGoVersionM = (stdout: string): PackageEntry[] => {
  const entries: PackageEntry[] = [];
  let pendingName: string | undefined;
  for (const line of stdout.split("\n")) {
    const pathMatch = /^\tpath\t(.+)$/.exec(line);
    if (pathMatch !== null) {
      if (pendingName !== undefined) entries.push({ name: pendingName });
      pendingName = pathMatch[1]?.trim();
      continue;
    }
    const modMatch = /^\tmod\t\S+\t(\S+)\t/.exec(line);
    if (modMatch !== null && pendingName !== undefined) {
      const version = modMatch[1];
      entries.push(version === undefined ? { name: pendingName } : { name: pendingName, version });
      pendingName = undefined;
    }
  }
  if (pendingName !== undefined) entries.push({ name: pendingName });
  return entries;
};

/** Declared here rather than inline at each `exec`, the same way this
 * backend's `versions` is: one statement of what this tool's own work costs. */
const goTimeouts: PackageTimeouts = { install: Timeouts.toolchain, refresh: Timeouts.indexRefresh };

export const makeGoBackend = (): PackageManagerBackend => ({
  id: "go-install",
  versions: goVersionSupport,
  timeouts: goTimeouts,
  list: (exec) =>
    exec({
      // A fixed, multi-statement shell script — conditional fallback,
      // command substitution, an unquoted glob that must expand, and a
      // trailing `; true` to keep an empty/missing bin dir from failing the
      // whole command (see the doc comment above). None of that is argv:
      // `Sh.sh`'s per-argument quoting would quote the glob and the `$(...)`
      // substitutions right out of meaning, so this is `Sh.unsafeRaw` rather
      // than a bug — there is no untrusted value interpolated here at all.
      command: Sh.unsafeRaw(
        'bin="$(go env GOBIN)"; [ -n "$bin" ] || bin="$(go env GOPATH)/bin"; go version -m "$bin"/* 2>/dev/null; true',
        "fixed multi-statement shell script (conditional, command substitution, glob); not expressible as a single argv-quoted command",
      ),
      shell: true,
    }).pipe(Effect.map((result) => parseGoVersionM(result.stdout))),
  install: (name, version, exec) =>
    UndefinedOr.match(version, {
      // `@latest` is appended here, not left to the recipe, so `name` stays
      // the bare import path `list` above can actually match against —
      // `go install` itself has no version-less form outside a module
      // context, so this is the closest equivalent to every other backend's
      // unpinned "whatever the manager resolves as current" install.
      onUndefined: () =>
        exec({
          command: Sh.sh("go", "install", `${name}@latest`),
          shell: true,
          timeout: goTimeouts.refresh,
        }).pipe(Effect.asVoid),
      onDefined: (spec) =>
        Match.value(spec).pipe(
          Match.tagsExhaustive({
            Exact: (v) =>
              exec({
                command: Sh.sh("go", "install", `${name}@${v.version}`),
                shell: true,
                timeout: goTimeouts.refresh,
              }).pipe(Effect.asVoid),
            AtLeast: rejectSpec,
            Channel: rejectSpec,
            Digest: rejectSpec,
          }),
        ),
    }),
});
