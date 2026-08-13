import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { providers } from "../src/index.ts";

/**
 * Proves the one thing this package exists for: `providers()` builds with
 * nothing left over except what Alchemy's own `StackServices` supplies to
 * every recipe — `FileSystem`, `Path`, `ChildProcessSpawner` (`NodeServices`,
 * also verified against `alchemy/src/Stack.ts`) and `HttpClient` (backed
 * there by `FetchHttpClient.layer`, same as here — `Machine.Download` needs
 * it and gets it structurally, with no import to remind you, exactly the
 * shape of gap this package exists to catch; see `dotfiles`' own
 * `Providers.ts`).
 *
 * If any package's `providers()` needed a service this aggregate forgot to
 * wire — the exact "silent runtime failure" documented in `Providers.ts` —
 * `Layer.build` would carry it in its unresolved requirement type, and the
 * `Effect.provide(...)` below would fail to type-check. This test is
 * therefore a compile-time proof as much as a runtime one: a `providers()`
 * change that regresses this stops `tsc -b`, not just a real `alchemy plan`.
 * (This is exactly how `HttpClient` was found to be a real, unmet
 * requirement while writing this test — not a stand-in gap.)
 */
it.effect("providers() resolves with only what Alchemy's StackServices supplies", () =>
  Layer.build(providers()).pipe(
    Effect.asVoid,
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.provide(FetchHttpClient.layer),
  ),
);
