import { Sh } from "@machine-run/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { BackendParseError, type PackageManagerBackend } from "../../Backend.ts";

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
const NpmLs = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);

const decodeNpmLs = Schema.decodeUnknownEffect(NpmLs);

export const makeNpmBackend = (): PackageManagerBackend => ({
  id: "npm",
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
        command: "npm ls -g --depth=0 --json; true",
        shell: true,
      });
      const parsed = yield* decodeNpmLs(result.stdout).pipe(
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(new BackendParseError({ manager: "npm", cause })),
        ),
      );
      return Object.keys(parsed.dependencies ?? {});
    }),
  install: (name, exec) =>
    exec({
      command: Sh.sh("npm", "install", "-g", name),
      shell: true,
      timeout: "5 minutes",
    }).pipe(Effect.asVoid),
});
