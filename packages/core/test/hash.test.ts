import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { sha256 } from "../src/hash.ts";

it.effect("hashes deterministically", () =>
  Effect.gen(function* () {
    const a = yield* sha256("hello");
    const b = yield* sha256("hello");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  }),
);

it.effect("different input hashes differently", () =>
  Effect.gen(function* () {
    const a = yield* sha256("hello");
    const b = yield* sha256("hello!");
    expect(a).not.toBe(b);
  }),
);
