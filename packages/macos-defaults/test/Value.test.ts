import { expect, it } from "@effect/vitest";
import * as Result from "effect/Result";
import {
  canonicalXml,
  data,
  date,
  type PlistDecodeError,
  type PlistValue,
  readXml,
  render,
} from "../src/Value.ts";

/** Unwraps a conversion the test expects to succeed. */
const ok = <A>(result: Result.Result<A, PlistDecodeError>): A => {
  if (Result.isFailure(result)) {
    throw new Error(`expected success, got: ${result.failure.message}`);
  }
  return result.success;
};

const xml = (value: PlistValue): string => ok(render(value));

it("round-trips every property-list type", () => {
  const value = {
    flag: true,
    count: 35,
    ratio: 2.5,
    name: "a b",
    blob: data("SGVsbG8="),
    when: date("2026-01-02T03:04:05.000Z"),
    list: [1, "two", false],
    nested: { inner: { deep: "value" } },
  };
  expect(ok(readXml(xml(value)))).toEqual(value);
});

it("distinguishes integers from reals", () => {
  expect(xml(3)).toContain("<integer>3</integer>");
  expect(xml(2.5)).toContain("<real>2.5</real>");
});

it("encodes data as base64 and dates as ISO-8601", () => {
  expect(xml(data("SGk="))).toContain("SGk=");
  expect(xml(date("2026-01-02T03:04:05.000Z"))).toContain(
    "<date>2026-01-02T03:04:05Z</date>",
  );
});

it("canonicalises differently-formatted XML to one spelling", () => {
  // plutil indents with tabs and puts data on its own lines; the serializer
  // used here does not. Both must reduce to the same text or every plan
  // reports drift that does not exist.
  const fromPlutil = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
\t<integer>7</integer>
\t<data>
\tSGk=
\t</data>
</array>
</plist>`;
  expect(ok(canonicalXml(fromPlutil))).toBe(xml([7, data("SGk=")]));
});

it("reports malformed base64 and dates as failures rather than writing a wrong value", () => {
  const badData = render(data("not base64!"));
  expect(Result.isFailure(badData)).toBe(true);
  if (Result.isFailure(badData)) expect(badData.failure.message).toMatch(/base64/);

  const badDate = render(date("never"));
  expect(Result.isFailure(badDate)).toBe(true);
  if (Result.isFailure(badDate)) expect(badDate.failure.message).toMatch(/valid date/);
});

it("reports unreadable XML as a failure", () => {
  expect(Result.isFailure(readXml("<plist>this is not"))).toBe(true);
});

it("serialises dictionary keys in a stable order but leaves array order alone", () => {
  // `defaults` stores dictionaries with their keys ordered, while an object
  // literal in a recipe carries insertion order. Without a stable order the
  // two spellings differ as text, so the key reports drift on every plan and
  // is rewritten forever without converging.
  expect(xml({ zebra: 1, alpha: 2 })).toBe(xml({ alpha: 2, zebra: 1 }));
  expect(xml({ b: { z: 1, a: 2 } })).toBe(xml({ b: { a: 2, z: 1 } }));

  // Array order is meaningful and must survive untouched.
  const arr = xml(["z", "a", "m"]);
  expect(arr.indexOf("<string>z</string>")).toBeLessThan(arr.indexOf("<string>a</string>"));
  expect(arr.indexOf("<string>a</string>")).toBeLessThan(arr.indexOf("<string>m</string>"));
});
