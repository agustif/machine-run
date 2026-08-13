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
      command:
        'bin="$(go env GOBIN)"; [ -n "$bin" ] || bin="$(go env GOPATH)/bin"; go version -m "$bin"/* 2>/dev/null; true',
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
