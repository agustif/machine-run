import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import * as UndefinedOr from "effect/UndefinedOr";
import {
  BackendParseError,
  type PackageEntry,
  type PackageManagerBackend,
  type PackageVersionSupport,
  rejectUnsupportedVersionSpec,
} from "../../Backend.ts";

/**
 * `npm install -g <name>@<version>` — verified against `docker run --rm
 * node:22`: `npm install -g cowsay@1.5.0` installed exactly that version, and
 * `npm install -g cowsay@99.99.99` failed with `npm error code ETARGET` /
 * `npm error notarget No matching version found for cowsay@99.99.99.`
 *
 * `canDowngrade: true` — the npm registry serves every published version
 * forever (barring an unpublish), and `npm install -g <name>@<olderversion>`
 * simply replaces whatever global install was there; nothing about the
 * command depends on which direction the version change goes.
 */
export const npmVersionSupport: PackageVersionSupport = {
  accepts: new Set(["Exact"]),
  canDowngrade: true,
};

const rejectSpec = rejectUnsupportedVersionSpec("npm", npmVersionSupport);

/**
 * `npm ls -g --depth=0 --json` prints `{ "dependencies": { "<name>": {...} } }`.
 *
 * Decoded with a real `Schema` rather than `JSON.parse(x) as NpmLsOutput`.
 * The cast was a lie: it told the compiler the shape was verified when
 * nothing had checked it, so any npm version that changed the key — or any
 * stdout that happened to be a bare `"null"` or a warning banner followed by
 * JSON — produced `undefined is not an object` deep inside `Object.keys`
 * instead of a typed parse failure at the boundary.
 *
 * The struct is deliberately not exhaustive: real `npm ls --json` output
 * can carry extra top-level keys (`problems`, `error`, `version`, `name`;
 * see `makeNpmBackend`'s own comment) that this doesn't need and
 * `Schema.Struct` ignores by default (`onExcessProperty: "ignore"`), rather
 * than failing to decode over fields nothing here reads.
 *
 * Verified against `docker run --rm node:22` (npm 10.9.8): a fresh image's
 * `npm ls -g --depth=0 --json` printed `{"name":"lib","dependencies":
 * {"corepack":{...},"npm":{...}}}` — the top-level `name` key this container
 * happened to add is exactly the kind of extra field `onExcessProperty:
 * "ignore"` above exists for — and after `npm install -g cowsay` and
 * `npm install -g typescript`, both new names appeared alongside the
 * originals with no other shape change (fixtures:
 * `test/fixtures/npm-ls-global-{before,after}.json`).
 */
/**
 * Each dependency's own record carries a `version` string alongside whatever
 * else npm reports (verified in the same container: `{"corepack":
 * {"version":"0.34.6",...},"cowsay":{"version":"1.5.0",...}}`) — no separate
 * command needed to learn what's installed at which version; `Schema.Unknown`
 * for the rest of each record's fields (`overridden`, sometimes `resolved`,
 * `problems`) is deliberately loose, since only `version` is read.
 */
const NpmLs = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Struct({ version: Schema.optionalKey(Schema.String) })),
    ),
  }),
);

const decodeNpmLs = Schema.decodeUnknownEffect(NpmLs);

export const makeNpmBackend = (): PackageManagerBackend => ({
  id: "npm",
  versions: npmVersionSupport,
  /**
   * `npm ls -g` exits non-zero (`ELSPROBLEMS`) whenever it finds *any*
   * problem in the global tree — an unmet peer dependency chief among
   * them — which otherwise turns a perfectly good listing into a
   * `CommandError` and fails observation for every declared npm package,
   * not just the unrelated one causing the problem. Confirmed locally by
   * reproducing the exit code (npm 11.17.0): a project depending on a
   * package with a peer dependency nothing satisfies makes plain
   * `npm ls --depth=0 --json` exit 1 with `npm error code ELSPROBLEMS` on
   * stderr — but stdout still holds the *complete*, well-formed JSON
   * listing (with an added top-level `problems`/`error` key describing
   * what's wrong), unchanged by the exit code. `alchemy`'s `CommandError`
   * for a non-zero exit only carries `exitCode`/`stderr` — never
   * `stdout` — so once npm's own exit code reaches Alchemy the listing is
   * unrecoverable; the fix has to keep the exit code from reaching Alchemy
   * at all. `shell: true` plus `; true` (the same idiom `Apt.ts`'s
   * `listRepos` uses for its own optional globs) does that: `npm error`
   * lines still go to stderr exactly as before, stdout is untouched, and
   * the compound command's own exit status is always 0, so `decodeNpmLs`
   * below always gets a real chance at the JSON instead of never running.
   */
  list: (exec) =>
    Effect.gen(function* () {
      const result = yield* exec({
        // `; true` neutralises npm's own `ELSPROBLEMS` exit code (see the doc
        // comment above) — a compound statement, not argv: `Sh.sh` would
        // quote the `;` as literal text rather than a statement separator.
        // No untrusted value is interpolated here.
        command: Sh.unsafeRaw(
          "npm ls -g --depth=0 --json; true",
          "compound statement; trailing `; true` neutralizes npm's own nonzero ELSPROBLEMS exit code, not expressible as a single argv-quoted command",
        ),
        shell: true,
      });
      const parsed = yield* decodeNpmLs(result.stdout).pipe(
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(new BackendParseError({ manager: "npm", cause })),
        ),
      );
      return Object.entries(parsed.dependencies ?? {}).map(
        ([name, dep]): PackageEntry =>
          dep.version === undefined ? { name } : { name, version: dep.version },
      );
    }),
  install: (name, version, exec) =>
    UndefinedOr.match(version, {
      onUndefined: () =>
        exec({
          command: Sh.sh("npm", "install", "-g", name),
          shell: true,
          timeout: "5 minutes",
        }).pipe(Effect.asVoid),
      onDefined: (spec) =>
        Match.value(spec).pipe(
          Match.tagsExhaustive({
            Exact: (v) =>
              exec({
                command: Sh.sh("npm", "install", "-g", `${name}@${v.version}`),
                shell: true,
                timeout: "5 minutes",
              }).pipe(Effect.asVoid),
            AtLeast: rejectSpec,
            Channel: rejectSpec,
            Digest: rejectSpec,
          }),
        ),
    }),
});
