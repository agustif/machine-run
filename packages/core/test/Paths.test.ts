import { NodeServices } from "@effect/platform-node";
import * as NodePath from "@effect/platform-node/NodePath";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { expandHome } from "../src/Paths.ts";

it.effect("expandHome resolves a bare home marker and normalises a home-relative path", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    expect(expandHome(path, "~", "/Users/alice")).toBe("/Users/alice");
    expect(expandHome(path, "~/projects/../.config", "/Users/alice")).toBe("/Users/alice/.config");
    expect(expandHome(path, "relative/../config", "/Users/alice")).toBe(path.resolve("config"));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("expandHome accepts a Windows-style home-relative separator", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    expect(expandHome(path, "~\\.ssh\\config", "C:\\Users\\alice")).toBe(
      "C:\\Users\\alice\\.ssh\\config",
    );
  }).pipe(Effect.provide(NodePath.layerWin32)),
);
