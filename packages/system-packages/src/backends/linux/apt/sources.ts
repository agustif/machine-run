import { lines } from "../../../parse.ts";

/**
 * Parsing apt's configured repositories out of the two on-disk formats.
 *
 * apt reads repositories from files that `add-apt-repository` itself writes,
 * which is a documented, stable interface (`sources.list(5)`), rather than
 * from `add-apt-repository --list`, whose output format carries no stability
 * guarantee across distro versions.
 *
 * There are two formats and a machine can use both at once:
 *
 * - **one-line**: `/etc/apt/sources.list` and `/etc/apt/sources.list.d/*.list`,
 *   each entry a single `deb <uri> <suite> <components>` line.
 * - **deb822**: `/etc/apt/sources.list.d/*.sources`, RFC822-style stanzas.
 *   This is the default on Ubuntu 24.04 and newer, where `sources.list`
 *   contains nothing but comments — so a parser that reads only the one-line
 *   format sees no repositories at all on a current Ubuntu.
 */

/** `.../ppa.launchpadcontent.net/<owner>/<name>/...` in either format. */
const PPA_URI = /ppa\.launchpadcontent\.net\/([^/\s]+)\/([^/\s]+)/;

/**
 * Repository identifiers from the one-line format.
 *
 * Both the `ppa:owner/name` shorthand and the raw line are reported, because
 * `add-apt-repository` accepts either form, so a repository added either way
 * must be recognised as already present.
 */
export const parseAptSources = (content: string): string[] => {
  const repos: string[] = [];
  for (const line of lines(content)) {
    if (line.startsWith("#")) continue;
    if (!line.startsWith("deb ") && !line.startsWith("deb-src ")) continue;
    const ppa = PPA_URI.exec(line);
    if (ppa) repos.push(`ppa:${ppa[1]}/${ppa[2]}`);
    repos.push(line);
  }
  return repos;
};

/**
 * Repository identifiers from the deb822 format.
 *
 * Only `URIs:` is read. A stanza's other fields describe *how* to fetch a
 * repository rather than which one it is, and one field in particular must not
 * be mistaken for data: `add-apt-repository` embeds the signing key inline
 * under `Signed-By:` as an armored PGP block whose continuation lines are
 * indented by one space (with `.` standing in for a blank line). Any line
 * beginning with whitespace therefore continues the previous field and is
 * skipped, or the base64 of a key would be read as further fields.
 *
 * Verified against the file `add-apt-repository -y ppa:git-core/ppa` writes on
 * Ubuntu 24.04 (`git-core-ubuntu-ppa-noble.sources`).
 */
export const parseDeb822Sources = (content: string): string[] => {
  const repos: string[] = [];
  for (const raw of content.split("\n")) {
    // A leading space or tab continues the previous field's value.
    if (/^\s/.test(raw)) continue;
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const separator = line.indexOf(":");
    if (separator === -1) continue;
    if (line.slice(0, separator).trim().toLowerCase() !== "uris") continue;

    // `URIs:` may list several space-separated mirrors for one repository.
    for (const uri of line.slice(separator + 1).trim().split(/\s+/)) {
      if (uri.length === 0) continue;
      const ppa = PPA_URI.exec(uri);
      if (ppa) repos.push(`ppa:${ppa[1]}/${ppa[2]}`);
      repos.push(uri);
    }
  }
  return repos;
};

/**
 * Everything apt currently has configured, from both formats.
 *
 * Takes the concatenated contents rather than reading files itself so it stays
 * a pure function: the backend does the I/O.
 */
export const parseAllSources = (oneLine: string, deb822: string): string[] => [
  ...parseAptSources(oneLine),
  ...parseDeb822Sources(deb822),
];
