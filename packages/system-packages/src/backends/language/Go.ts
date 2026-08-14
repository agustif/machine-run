import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import type { PackageManagerBackend } from "../../Backend.ts";

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
 * binary itself, on a line shaped `\tpath\t<import path>` — this is standard
 * Go build-info embedding, not something scraped from a filename. Running
 * it once over every file in the bin directory (`go version -m dir/*`)
 * avoids one shell-out per installed binary.
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
 * multi-binary block (fixture: `test/fixtures/go-version-m.txt`).
 *
 * This container also surfaced a real, if incidental, finding about
 * `install`'s `@latest`: `go install golang.org/x/tools/cmd/goimports@latest`
 * failed outright against go1.23.12 with `golang.org/x/tools@v0.49.0
 * requires go >= 1.25.0 (running go 1.23.12; GOTOOLCHAIN=local)` — a
 * dependency's own floor, not a missing-binary error, and not something
 * `parseGoVersionM` or `list` can do anything about. A machine whose Go is
 * older than whatever `@latest` currently requires will see `install` fail
 * this way; there is no fix here beyond noting it, since pinning a version
 * would require the `version` field `PackageProps` doesn't have yet (see
 * the gap noted on `install` below).
 */
export const parseGoVersionM = (stdout: string): string[] => {
  const paths: string[] = [];
  const marker = "\tpath\t";
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(marker)) continue;
    const value = line.slice(marker.length).trim();
    if (value.length > 0) paths.push(value);
  }
  return paths;
};

export const makeGoBackend = (): PackageManagerBackend => ({
  id: "go-install",
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
  // `@latest` is appended here, not left to the recipe, so `name` stays the
  // bare import path `list` above can actually match against — this backend
  // has no version pinning, the same gap `TASKS.md` records for every
  // backend (`PackageProps` has no `version` field yet).
  install: (name, exec) =>
    exec({
      command: Sh.sh("go", "install", `${name}@latest`),
      shell: true,
      timeout: "10 minutes",
    }).pipe(Effect.asVoid),
});
