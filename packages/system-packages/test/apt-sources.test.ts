import { expect, it } from "@effect/vitest";
import {
  parseAllSources,
  parseAptSources,
  parseDeb822Sources,
} from "../src/backends/linux/apt/sources.ts";

/**
 * Captured verbatim from `add-apt-repository -y ppa:git-core/ppa` on a real
 * `ubuntu:24.04` container — including the inline armored signing key, whose
 * space-indented continuation lines are the thing most likely to break a naive
 * line-oriented parser.
 */
const REAL_PPA_SOURCES = `Types: deb
URIs: https://ppa.launchpadcontent.net/git-core/ppa/ubuntu/
Suites: noble
Components: main
Signed-By:
 -----BEGIN PGP PUBLIC KEY BLOCK-----
 .
 mQINBGYo2OYBEADVRjI+o29u9izslaVr0Xqj8hpmo/2su/Iey1PgoS6A3hMxR4R4
 eZ3u9dRh/gRHXNjxqRMfKj88G6ciqa/7ty8Vfc1eKl3z7yjL1pWOEzcGLKaSB8qd
 -----END PGP PUBLIC KEY BLOCK-----
`;

/** Ubuntu 24.04's own default sources file, same format. */
const UBUNTU_DEFAULT_SOURCES = `## See the sources.list(5) manual page for further settings.
Types: deb
URIs: http://ports.ubuntu.com/ubuntu-ports/
Suites: noble noble-updates noble-backports
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
`;

it("recovers the ppa: shorthand from a real add-apt-repository .sources file", () => {
  const repos = parseDeb822Sources(REAL_PPA_SOURCES);
  expect(repos).toContain("ppa:git-core/ppa");
});

it("does not read the inline signing key as further fields", () => {
  const repos = parseDeb822Sources(REAL_PPA_SOURCES);
  // Exactly one URI is declared; anything more means base64 from the PGP
  // block was parsed as data.
  expect(repos).toEqual([
    "ppa:git-core/ppa",
    "https://ppa.launchpadcontent.net/git-core/ppa/ubuntu/",
  ]);
});

it("reads a non-PPA deb822 stanza without inventing a shorthand", () => {
  const repos = parseDeb822Sources(UBUNTU_DEFAULT_SOURCES);
  expect(repos).toEqual(["http://ports.ubuntu.com/ubuntu-ports/"]);
  expect(repos.some((r) => r.startsWith("ppa:"))).toBe(false);
});

it("keeps every mirror when one stanza lists several URIs", () => {
  const repos = parseDeb822Sources(
    "Types: deb\nURIs: http://a.example/ubuntu http://b.example/ubuntu\nSuites: noble\n",
  );
  expect(repos).toEqual(["http://a.example/ubuntu", "http://b.example/ubuntu"]);
});

it("still parses the one-line format", () => {
  const repos = parseAptSources(
    [
      "# a comment, ignored",
      "",
      "deb http://archive.ubuntu.com/ubuntu jammy main restricted",
      "deb http://ppa.launchpadcontent.net/some/tap/ubuntu jammy main",
    ].join("\n"),
  );
  expect(repos).toContain("ppa:some/tap");
  // The raw line is kept too: `add-apt-repository` accepts a full `deb` line
  // as well as the shorthand, so either spelling must read as already-present.
  expect(repos).toContain("deb http://ppa.launchpadcontent.net/some/tap/ubuntu jammy main");
});

it("reports repositories from both formats at once", () => {
  const repos = parseAllSources(
    "deb http://ppa.launchpadcontent.net/one/tap/ubuntu jammy main",
    REAL_PPA_SOURCES,
  );
  expect(repos).toContain("ppa:one/tap");
  expect(repos).toContain("ppa:git-core/ppa");
});

it("returns nothing when apt has no configured sources", () => {
  expect(parseAllSources("", "")).toEqual([]);
});
