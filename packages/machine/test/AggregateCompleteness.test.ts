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
 * Every workspace package that defines a resource must appear in this
 * aggregate's merge.
 *
 * `Providers.test.ts` proves the layer *resolves* — that nothing it wires is
 * missing a service. It cannot notice that a package was never wired at all,
 * because a layer that merges nine of ten packages resolves exactly as cleanly
 * as one that merges ten. That omission is the precise failure this package
 * exists to prevent, and it is a *runtime* one: a recipe using the missing
 * package's resource fails at `alchemy plan` with "service not found", not at
 * `tsc -b`.
 *
 * So this reads source. It cannot be done by resolving the layer, because a
 * `Layer` carries no runtime list of what it provides, and a type-level check
 * would only cover resources a test file happened to name — which is the same
 * gap one level up.
 *
 * A package earns its way into this check by defining at least one
 * `Resource<T>("Type.Name")`. Composition-only packages like `@machine-run/ssh`
 * define none and are correctly absent — until they gain one, at which point
 * this test starts failing and names them.
 */
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const packagesDir = Path.join(repoRoot, "packages");

const tsFilesIn = (dir: string): readonly string[] =>
  Fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = Path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFilesIn(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });

/** Workspace packages that define at least one Alchemy resource. */
const resourceDefiningPackages = (): readonly string[] =>
  Fs.readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => {
      const srcDir = Path.join(packagesDir, entry.name, "src");
      // See ExampleCoverage.test.ts: a directory lacking either is a package
      // mid-creation, not one missing from the aggregate.
      if (!Fs.existsSync(srcDir)) return false;
      if (!Fs.existsSync(Path.join(packagesDir, entry.name, "package.json"))) return false;
      return tsFilesIn(srcDir).some((file) =>
        /export const \w+ = Resource<[^>]*>\(/.test(Fs.readFileSync(file, "utf8")),
      );
    })
    .map((entry) => {
      const manifest = Path.join(packagesDir, entry.name, "package.json");
      return packageNameOf(manifest);
    });

it("every resource-defining package is merged into the aggregate layer", () => {
  const source = Fs.readFileSync(Path.join(packagesDir, "machine/src/Providers.ts"), "utf8");

  // Namespace alias per package, so a package renamed in the import but never
  // added to the merge is still caught.
  const aliases = new Map<string, string>();
  for (const match of source.matchAll(/import \* as (\w+) from "(@machine-run\/[\w-]+)"/g)) {
    aliases.set(match[2] ?? "", match[1] ?? "");
  }

  const missing = resourceDefiningPackages()
    .filter((pkg) => pkg !== "@machine-run/machine")
    .filter((pkg) => {
      const alias = aliases.get(pkg);
      return alias === undefined || !source.includes(`${alias}.providers()`);
    })
    .sort();

  expect(missing).toEqual([]);
});

it("finds the packages it is meant to be checking", () => {
  // Without this, a change to how resources are declared would make the check
  // above pass by finding nothing at all — the failure mode of every test that
  // asserts an empty list.
  const packages = resourceDefiningPackages();
  expect(packages.length).toBeGreaterThan(8);
  expect(packages).toContain("@machine-run/dotfiles");
  expect(packages).toContain("@machine-run/tailscale");
});
