import { expect, it } from "@effect/vitest";
import { versionSatisfies } from "../src/version.ts";

it("a fuzzy major-only request is satisfied by any matching patch", () => {
  expect(versionSatisfies("22", "22.11.0")).toBe(true);
  expect(versionSatisfies("22", "22.0.0")).toBe(true);
  expect(versionSatisfies("22", "20.11.0")).toBe(false);
});

it("a major.minor request is satisfied only by that minor line", () => {
  expect(versionSatisfies("22.11", "22.11.0")).toBe(true);
  expect(versionSatisfies("22.11", "22.12.0")).toBe(false);
});

it("an exact request requires an exact match", () => {
  expect(versionSatisfies("22.11.0", "22.11.0")).toBe(true);
  expect(versionSatisfies("22.11.0", "22.11.1")).toBe(false);
});

it("a longer request than the observed version can never be satisfied", () => {
  expect(versionSatisfies("22.11.0", "22")).toBe(false);
});

it("a non-dotted request (a rustup channel) falls back to exact equality", () => {
  expect(versionSatisfies("stable", "stable")).toBe(true);
  expect(versionSatisfies("stable", "1.97.1")).toBe(false);
  expect(versionSatisfies("nightly", "nightly-2024-01-01")).toBe(false);
});

it("a dotted request never matches a non-dotted observed value", () => {
  expect(versionSatisfies("22", "stable")).toBe(false);
});
