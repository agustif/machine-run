import { expect, it } from "@effect/vitest";
import * as Fs from "node:fs";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `examples/complete-machine` has to exercise every resource kind this repo
 * defines.
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
      if (!Fs.existsSync(srcDir)) return [];
      const pkg = JSON.parse(
        Fs.readFileSync(Path.join(packagesDir, entry.name, "package.json"), "utf8"),
      ).name as string;
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
