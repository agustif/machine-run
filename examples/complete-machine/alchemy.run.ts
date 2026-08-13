import * as Machine from "@machine-run/machine";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { ai } from "./recipes/ai.ts";
import { dotfiles } from "./recipes/dotfiles.ts";
import { git } from "./recipes/git.ts";
import { linux } from "./recipes/linux.ts";
import { macos } from "./recipes/macos.ts";
import { network } from "./recipes/network.ts";
import { packages } from "./recipes/packages.ts";
import { runtimes } from "./recipes/runtimes.ts";
import { secrets } from "./recipes/secrets.ts";
import { services } from "./recipes/services.ts";
import { shell } from "./recipes/shell.ts";

/**
 * Every resource kind this repo defines, exercised once, as compiled code.
 *
 * This is a reference, not a machine. Do not deploy it as written: it names
 * secret references that do not exist, a placeholder download checksum, a
 * `chsh` call, and both macOS and Linux desktop settings — which cannot both
 * apply on one host. Copy the recipes you want into your own stack instead.
 *
 * It exists because the alternative rots. `examples/example-machine` carried
 * four of these domains as commented-out prose, and commented-out code is
 * never type-checked: it kept referencing a package months after that package
 * was deleted, and nothing failed. Everything here is real, so `tsc -b`
 * catches a prop rename the moment it happens, and
 * `packages/machine/test/ExampleCoverage.test.ts` fails if a new resource kind
 * lands without being added to a recipe.
 *
 * The recipes are split by domain rather than kept in one file so that adding a
 * resource means editing the module that owns its domain.

 */
export default Alchemy.Stack<{}>()(
  "complete-machine",
  {
    providers: Machine.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    yield* packages;
    yield* dotfiles;
    yield* shell;
    yield* git;
    yield* runtimes;
    yield* secrets;
    yield* ai;
    yield* macos;
    yield* linux;
    yield* network;
    yield* services;
  }),
);
