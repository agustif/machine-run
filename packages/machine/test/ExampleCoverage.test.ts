import { expect, it } from "@effect/vitest";
import * as Fs from "node:fs";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";
import * as Schema from "effect/Schema";

/** A package manifest's `name` field — `Schema.Json` codecs rather than `JSON.parse`. */
const packageNameOf = (manifestPath: string): string =>
  Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ name: Schema.String })))(
    Fs.readFileSync(manifestPath, "utf8"),
  ).name;

/**
 * `examples/complete-machine` has to exercise every resource kind this repo
 * defines, *and* every composition function built on top of them.
 *
 * The failure this prevents already happened once: `examples/example-machine`
 * carried four domains as commented-out prose, and because commented code is
 * never type-checked, it went on referencing `@machine-run/ai-tools` after that
 * package was deleted without anything going red. A resource with no example is
 * a resource whose props nobody has ever had to spell correctly.
 *
 * This reads source rather than executing the stack because executing it would
 * require an Alchemy runtime and a machine willing to be modified. What it can
 * still prove is that a call exists, spelled against the real export, in a file
 * `tsc -b` compiles.
 *
 * ## What counts as a composition
 *
 * `gitIdentity`, `Shell.func`, `aiSkill` and the rest are plain exported
 * functions, not `Resource<T>(...)` calls, so they need a rule of their own — one
 * that finds real compositions without dragging in every helper a resource
 * package happens to export. A candidate counts only if *all* of these hold:
 *
 * 1. It lives in a "resource-defining" package — one that declares at least one
 *    `Resource<T>(...)`, the same test `AggregateCompleteness.test.ts` uses to
 *    decide which packages must appear in the aggregate layer. This is what
 *    keeps `packages/core` and `packages/state`'s internal plumbing
 *    (`ensureDataKey`, `readSecret`, `detectSystemPackageManager`, ...) out:
 *    they return Effects too, but neither package defines a resource.
 * 2. It is exported from that package's `src/index.ts`, directly or via a
 *    chained `export * from "./file.ts"` — an internal helper `index.ts` never
 *    re-exports is, by construction, not part of the package's public surface.
 * 3. Its declaration is a plain arrow function, `export const name = (...) =>`
 *    — not `export const name = Resource<...>(...)` (a resource, already
 *    covered above) and not a bare value/object/schema.
 * 4. Somewhere between that declaration and the next top-level `export`, its
 *    source calls — bare or namespace-qualified — an identifier that is either
 *    a known resource constructor (`Dotfiles.File(`, `Config(`, ...) or another
 *    function already confirmed by this same rule. The second half of that is
 *    load-bearing: `gitIgnore` and `gitAttributes` only ever call
 *    `gitConfigFile`, never a resource directly, and `aiSkills`/`aiConfigs` only
 *    ever call `aiSkill`/`aiConfig` — so confirming compositions is a fixpoint,
 *    not a single pass.
 *
 * Rule (4) is what keeps this from flagging `ssh/Host.ts`'s own
 * `sshHostBlockProps` (returns a plain `Dotfiles.ManagedBlockProps` object, no
 * resource call in sight) even though it sits in the same file, matches the
 * same arrow shape, and is exported right alongside the real `sshHost`
 * composition it feeds.
 */
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

interface ResourceKind {
  /** The Alchemy resource type string, e.g. `"Git.Config"`. */
  readonly type: string;
  /** The exported constructor's identifier, e.g. `"Config"`. */
  readonly exported: string;
  /** Its owning package, e.g. `"@machine-run/git"`. */
  readonly pkg: string;
}

const tsFilesIn = (dir: string): readonly string[] =>
  Fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = Path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFilesIn(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });

const declaredResources = (): readonly ResourceKind[] => {
  const packagesDir = Path.join(repoRoot, "packages");
  return Fs.readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const srcDir = Path.join(packagesDir, entry.name, "src");
      const manifest = Path.join(packagesDir, entry.name, "package.json");
      // A directory without both is a package mid-creation, not a package that
      // forgot its resources. Crashing here would turn an unrelated in-progress
      // change into a failure of this check.
      if (!Fs.existsSync(srcDir) || !Fs.existsSync(manifest)) return [];
      const pkg = packageNameOf(manifest);
      return tsFilesIn(srcDir).flatMap((file) => {
        const source = Fs.readFileSync(file, "utf8");
        return [...source.matchAll(/export const (\w+) = Resource<[^>]*>\(\s*"([^"]+)"/g)].map(
          (match) => ({ exported: match[1] ?? "", type: match[2] ?? "", pkg }),
        );
      });
    });
};

/**
 * Which resource kinds one example file calls.
 *
 * Resolving the import alias matters rather than just grepping the identifier:
 * `Repo` is exported by both `@machine-run/git` and
 * `@machine-run/system-packages`, so an unqualified `Repo(` would let either
 * one satisfy both.
 */
const kindsUsedIn = (source: string, kinds: readonly ResourceKind[]): ReadonlySet<string> => {
  const namespaceAliases = new Map<string, string>();
  for (const match of source.matchAll(/import \* as (\w+) from "(@machine-run\/[\w-]+)"/g)) {
    namespaceAliases.set(match[2] ?? "", match[1] ?? "");
  }
  const namedImports = new Map<string, ReadonlySet<string>>();
  for (const match of source.matchAll(/import \{([^}]*)\} from "(@machine-run\/[\w-]+)"/g)) {
    const names = (match[1] ?? "").split(",").map((name) => name.trim().split(/\s+as\s+/)[0] ?? "");
    namedImports.set(match[2] ?? "", new Set(names));
  }

  const used = new Set<string>();
  for (const kind of kinds) {
    const alias = namespaceAliases.get(kind.pkg);
    const qualified = alias !== undefined && source.includes(`${alias}.${kind.exported}(`);
    const bare =
      namedImports.get(kind.pkg)?.has(kind.exported) === true &&
      source.includes(`${kind.exported}(`);
    if (qualified || bare) used.add(kind.type);
  }
  return used;
};

it("every resource kind is exercised by examples/complete-machine", () => {
  const kinds = declaredResources();
  // A guard on the extraction itself: if the declaration form changes and the
  // pattern silently matches nothing, an empty list would otherwise pass.
  expect(kinds.length).toBeGreaterThan(10);

  const exampleDir = Path.join(repoRoot, "examples", "complete-machine");
  const used = new Set(
    tsFilesIn(exampleDir)
      .filter((file) => !file.includes(`${Path.sep}lib${Path.sep}`))
      .flatMap((file) => [...kindsUsedIn(Fs.readFileSync(file, "utf8"), kinds)]),
  );

  const uncovered = kinds
    .filter((kind) => !used.has(kind.type))
    .map((kind) => `${kind.type} (${kind.pkg} exports ${kind.exported})`)
    .sort();

  expect(uncovered).toEqual([]);
});

/** A package that defines at least one `Resource<T>(...)` — see `AggregateCompleteness.test.ts`. */
interface ResourcePackage {
  readonly name: string;
  readonly dir: string;
}

const resourceDefiningPackages = (): readonly ResourcePackage[] => {
  const packagesDir = Path.join(repoRoot, "packages");
  return Fs.readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const dir = Path.join(packagesDir, entry.name);
      const srcDir = Path.join(dir, "src");
      const manifest = Path.join(dir, "package.json");
      // Same guard as `declaredResources`: a package mid-creation is skipped,
      // not treated as one that forgot its resources.
      if (!Fs.existsSync(srcDir) || !Fs.existsSync(manifest)) return [];
      const definesResource = tsFilesIn(srcDir).some((file) =>
        /export const \w+ = Resource<[^>]*>\(/.test(Fs.readFileSync(file, "utf8")),
      );
      if (!definesResource) return [];
      const name = packageNameOf(manifest);
      return [{ name, dir }];
    });
};

/**
 * Every file a package's `src/index.ts` re-exports via `export * from
 * "./file.ts"` — its public surface. `export * as Name from "..."` (used by
 * `@machine-run/core` for `Sh`/`Windows`) is deliberately not matched: none of
 * the resource-defining packages namespace their compositions that way today,
 * and a package that started would need its own alias-resolution rule here,
 * the same way `kindsUsedIn` resolves aliases on the example side.
 */
const indexReexportedFiles = (pkgDir: string): readonly string[] => {
  const indexPath = Path.join(pkgDir, "src", "index.ts");
  if (!Fs.existsSync(indexPath)) return [];
  const source = Fs.readFileSync(indexPath, "utf8");
  return [...source.matchAll(/^export \* from "\.\/(.+)\.ts";$/gm)].map((match) =>
    Path.join(pkgDir, "src", `${match[1] ?? ""}.ts`),
  );
};

interface CompositionCandidate {
  /** The exported identifier, e.g. `"gitIdentity"`. */
  readonly name: string;
  /** Its owning package, e.g. `"@machine-run/git"`. */
  readonly pkg: string;
  /**
   * Source from this declaration up to (not including) the next top-level
   * `export` — an approximation of "this function's body" that needs no real
   * parser, since no top-level `export` can appear nested inside one.
   */
  readonly region: string;
}

/** Every plain-arrow-function export in one file — resource constructors excluded by construction (see rule 3). */
const compositionCandidatesIn = (pkg: string, file: string): readonly CompositionCandidate[] => {
  const source = Fs.readFileSync(file, "utf8");
  const boundaries = [...source.matchAll(/^export /gm)].map((match) => match.index ?? 0);
  return [...source.matchAll(/^export const (\w+) = \(/gm)].map((match) => {
    const start = match.index ?? 0;
    const end = boundaries.find((boundary) => boundary > start) ?? source.length;
    return { name: match[1] ?? "", pkg, region: source.slice(start, end) };
  });
};

/** Whether `region` calls `identifier` as a function — `\b` keeps `hook(` from matching inside `hookup(`. */
const callsIdentifier = (region: string, identifier: string): boolean =>
  new RegExp(`\\b${identifier}\\(`).test(region);

/**
 * The fixpoint described in this file's doc comment: a candidate is confirmed
 * the moment its region calls either a known resource constructor or a
 * candidate already confirmed in an earlier pass, and passes repeat until one
 * makes no further progress.
 */
const confirmCompositions = (
  candidates: readonly CompositionCandidate[],
  resourceNames: ReadonlySet<string>,
): readonly CompositionCandidate[] => {
  const confirmed = new Map<string, CompositionCandidate>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates) {
      const key = `${candidate.pkg}#${candidate.name}`;
      if (confirmed.has(key)) continue;
      const callsResource = [...resourceNames].some((name) =>
        callsIdentifier(candidate.region, name),
      );
      const callsComposition = [...confirmed.values()].some((other) =>
        callsIdentifier(candidate.region, other.name),
      );
      if (callsResource || callsComposition) {
        confirmed.set(key, candidate);
        changed = true;
      }
    }
  }
  return [...confirmed.values()];
};

const declaredCompositions = (): readonly ResourceKind[] => {
  const resourceNames = new Set(declaredResources().map((kind) => kind.exported));
  const candidates = resourceDefiningPackages().flatMap(({ name, dir }) =>
    indexReexportedFiles(dir).flatMap((file) => compositionCandidatesIn(name, file)),
  );
  return confirmCompositions(candidates, resourceNames).map((composition) => ({
    type: `${composition.pkg}#${composition.name}`,
    exported: composition.name,
    pkg: composition.pkg,
  }));
};

it("every composition function is exercised by examples/complete-machine", () => {
  const compositions = declaredCompositions();
  // Same guard as the resource check: if the extraction rule stops matching
  // anything, an empty list must not read as "fully covered".
  expect(compositions.length).toBeGreaterThan(15);

  const exampleDir = Path.join(repoRoot, "examples", "complete-machine");
  const used = new Set(
    tsFilesIn(exampleDir)
      .filter((file) => !file.includes(`${Path.sep}lib${Path.sep}`))
      .flatMap((file) => [...kindsUsedIn(Fs.readFileSync(file, "utf8"), compositions)]),
  );

  const uncovered = compositions
    .filter((composition) => !used.has(composition.type))
    .map((composition) => `${composition.pkg} exports ${composition.exported}`)
    .sort();

  expect(uncovered).toEqual([]);
});
