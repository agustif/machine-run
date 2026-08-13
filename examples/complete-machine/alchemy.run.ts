import { services as coreServices } from "@machine-run/core";
import * as Machine from "@machine-run/machine";
import * as SystemServices from "@machine-run/system-services";
import * as Alchemy from "alchemy";
import { CommandExecutorLive } from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
 *
 * `@machine-run/system-services` is not yet folded into `Machine.providers()`
 * itself (see `docs/TASKS.md`), so its own `providers()` is merged in here
 * directly — exactly the escape hatch `packages/machine/src/Providers.ts`'s
 * own doc comment describes for a package the aggregate doesn't cover yet.
 * Unlike `Machine.providers()` (which already closes over its own
 * `Core.services()`/`CommandExecutorLive()` internally), `SystemServices.providers()`
 * leaves those to the composing recipe — the same convention every resource
 * package here follows, see that package's own `Providers.ts` — so this
 * stack supplies them once more on the outside, the identical shape
 * `packages/machine/src/Providers.ts`'s final `.pipe(...)` uses.
 */
export default Alchemy.Stack<{}>()(
  "complete-machine",
  {
    providers: Layer.mergeAll(Machine.providers(), SystemServices.providers()).pipe(
      Layer.provideMerge(coreServices()),
      Layer.provide(CommandExecutorLive()),
    ),
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
