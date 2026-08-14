import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import * as nodeProcess from "node:process";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = join(project, "packages");
const links = join(project, "node_modules", "@machine-run");

const workspacePackages = new Map();
for (const entry of readdirSync(packages, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packageDirectory = join(packages, entry.name);
  // The workspace convention is one package per packages/<name> directory,
  // published as @machine-run/<name>. npm's workspace links use that same
  // suffix, so deriving it from the directory keeps this guard static and
  // avoids silently parsing an arbitrary manifest as an untyped object.
  if (existsSync(join(packageDirectory, "package.json"))) {
    workspacePackages.set(entry.name, packageDirectory);
  }
}

const failures = [];
for (const [name, packageDirectory] of workspacePackages) {
  const link = join(links, name);
  if (!existsSync(link)) {
    failures.push(`${link} is missing or cannot be resolved`);
    continue;
  }
  if (!lstatSync(link).isSymbolicLink()) {
    failures.push(`${link} is a real directory, not a workspace link`);
    continue;
  }

  const actual = realpathSync(link);
  const expected = realpathSync(packageDirectory);
  if (actual !== expected) {
    failures.push(`${link} resolves to ${actual}, expected ${expected}`);
  }
}

if (failures.length > 0) {
  const checkout = relative(process.cwd(), project) || ".";
  nodeProcess.stderr.write(`workspace preflight failed for checkout ${checkout}:\n`);
  nodeProcess.stderr.write(`${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  nodeProcess.stderr.write("Run npm ci from this checkout before building.\n");
  nodeProcess.exit(1);
}
