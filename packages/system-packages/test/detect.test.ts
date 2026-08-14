import { PlatformFor } from "@machine-run/core";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { detectSystemPackageManager } from "../src/detect.ts";

it.effect("detects the native macOS manager from the injected platform", () =>
  detectSystemPackageManager.pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, PlatformFor("darwin"))),
    Effect.map((manager) => expect(manager).toBe("brew")),
  ),
);

it.effect("detects the native Windows manager from the injected platform", () =>
  detectSystemPackageManager.pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, PlatformFor("win32"))),
    Effect.map((manager) => expect(manager).toBe("winget")),
  ),
);
