import * as Data from "effect/Data";
import * as Encoding from "effect/Encoding";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { build, parse, type PlistValue as NativePlistValue } from "plist";

/**
 * A property-list value, in a form that survives being persisted as JSON.
 *
 * Alchemy stores a resource's props in its state file as JSON, so props may
 * only contain values `JSON.stringify`/`JSON.parse` round-trips exactly. Two
 * property-list types do not qualify: `<data>` becomes a `Uint8Array` and
 * `<date>` a `Date`, and both degrade silently — a `Date` reappears as a
 * string, a `Uint8Array` as an object with numeric keys. Either would compare
 * unequal to the value that produced it and report drift on every plan.
 *
 * Both are therefore written as tagged wrappers, which are ordinary JSON.
 * The cost is that a dictionary whose key is literally `$data` or `$date`
 * cannot be expressed; nothing in `defaults` uses such keys.
 */
export type PlistValue = boolean | number | string | PlistData | PlistDate | PlistArray | PlistDict;

/**
 * The recursive cases are interfaces rather than inline type literals so that
 * their resolution is deferred. Alchemy maps every prop type through `Input<>`,
 * and a directly self-referential type alias is expanded eagerly through that
 * mapping until the compiler gives up with "type instantiation is excessively
 * deep".
 */
export interface PlistArray extends ReadonlyArray<PlistValue> {}

export interface PlistDict {
  readonly [key: string]: PlistValue;
}

/** Binary data, base64-encoded — a `<data>` element. */
export interface PlistData {
  readonly $data: string;
}

/** An instant, ISO-8601 encoded — a `<date>` element. */
export interface PlistDate {
  readonly $date: string;
}

/**
 * Runtime validation for a property-list value.
 *
 * The schema is annotated with {@link PlistValue} rather than having the type
 * derived from it. That is Effect's own idiom for a recursive schema — the
 * type must exist before `suspend` can refer to it — and here it is also
 * required for a second reason: Alchemy maps every prop type through
 * `Input<>`, which expands a directly self-referential type alias eagerly
 * until the compiler reports "type instantiation is excessively deep". The
 * interfaces above defer that expansion; a derived alias would not.
 */
export const data = (base64: string): PlistData => ({ $data: base64 });
export const date = (iso: string): PlistDate => ({ $date: iso });

const PlistDataSchema = Schema.Struct({ $data: Schema.String });

const PlistDateSchema = Schema.Struct({ $date: Schema.String });

/**
 * Runtime validation for a property-list value, so a value arriving from a
 * recipe is checked rather than trusted.
 *
 * The type is written by hand and the schema annotated with it, rather than
 * the type being derived from the schema. A recursive schema cannot infer its
 * own type, and the hand-written interfaces above additionally keep Alchemy's
 * `Input<>` mapping from expanding the self-reference until the compiler
 * reports "type instantiation is excessively deep".
 */
export const PlistValueSchema: Schema.Codec<PlistValue> = Schema.suspend(
  (): Schema.Codec<PlistValue> =>
    // The recursive union cannot be expressed without the assertion on this
    // expression's closing line: see this constant's doc comment, which records
    // the "type instantiation is excessively deep" failure it avoids.
    // oxlint-disable-next-line effect/noAs
    Schema.Union([
      Schema.Boolean,
      Schema.Number,
      Schema.String,
      PlistDataSchema,
      PlistDateSchema,
      Schema.Array(PlistValueSchema),
      Schema.Record(Schema.String, PlistValueSchema),
    ]) as Schema.Codec<PlistValue>,
);

export class PlistDecodeError extends Data.TaggedError("PlistDecodeError")<{
  detail: string;
  cause?: unknown;
}> {
  override get message() {
    return `Could not read a property-list value: ${this.detail}`;
  }
}

/**
 * The tagged wrappers are recognised by decoding them against the same schemas
 * that validate them coming in from a recipe, rather than by hand-written
 * shape checks. One definition then decides both what is accepted and what is
 * recognised, so the two can never drift apart.
 */
const asData = Schema.decodeUnknownOption(PlistDataSchema);
const asDate = Schema.decodeUnknownOption(PlistDateSchema);

/**
 * Structural dispatch over the remaining cases.
 *
 * This is a JavaScript-shape question — "is this a plain object rather than an
 * array or a primitive" — not a domain one, and it runs before any schema
 * could apply, since which schema to try is exactly what it decides.
 */
const isRecord = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);



/**
 * Every conversion below returns a {@link Result} rather than throwing.
 *
 * These are pure, total functions over data that arrives from a recipe or from
 * `plutil`, so failure is an ordinary outcome — invalid base64, an unparseable
 * date, a value of a type property lists cannot hold. Returning it keeps the
 * failure in the type, lets the caller lift it into an Effect at one place, and
 * keeps the whole module testable without a runtime.
 */
/**
 * A two-element tuple typed from its own arguments, so `Object.fromEntries`
 * receives a real `readonly [K, V]` rather than a widened `(K | V)[]`. The same
 * helper `Ai.McpServer` uses for the same reason — the alternative is a
 * `as const` on every pair.
 */
const entry = <K, V>(key: K, value: V): readonly [K, V] => [key, value];

const traverse = <A, B>(
  items: ReadonlyArray<A>,
  f: (item: A) => Result.Result<B, PlistDecodeError>,
): Result.Result<ReadonlyArray<B>, PlistDecodeError> => {
  const out: B[] = [];
  for (const item of items) {
    const converted = f(item);
    // Re-wrapped rather than returned as-is: a `Failure<B, E>` and a
    // `Failure<B[], E>` carry the same value but are different types.
    if (Result.isFailure(converted)) return Result.fail(converted.failure);
    out.push(converted.success);
  }
  return Result.succeed(out);
};

/**
 * Converts the JSON-safe representation into the shapes the plist serializer
 * expects: `Uint8Array` for `<data>`, `Date` for `<date>`.
 */
const toNative = (value: PlistValue): Result.Result<NativePlistValue, PlistDecodeError> => {
  const asBinary = asData(value);
  if (Option.isSome(asBinary)) {
    const encoded = asBinary.value.$data;
    const decoded = Encoding.decodeBase64(encoded);
    return Result.isFailure(decoded)
      ? Result.fail(
          new PlistDecodeError({
            detail: `"${encoded}" is not valid base64`,
            cause: decoded.failure,
          }),
        )
      : Result.succeed(decoded.success);
  }

  const asInstant = asDate(value);
  if (Option.isSome(asInstant)) {
    const iso = asInstant.value.$date;
    return DateTime.make(iso).pipe(
      Option.match({
        onNone: () => Result.fail(new PlistDecodeError({ detail: `"${iso}" is not a valid date` })),
        onSome: (instant) => Result.succeed(DateTime.toDate(instant)),
      }),
    );
  }

  // Copied into a mutable array rather than passed through: `plist`'s own
  // `PlistValue` types an array as `PlistValue[]`, and `traverse` produces a
  // `readonly` one. The copy is what makes that difference explicit instead of
  // hidden behind an assertion.
  if (Array.isArray(value)) {
    return Result.map(traverse(value, toNative), (items) => [...items]);
  }

  if (isRecord(value)) {
    // Dictionary keys are sorted so serialization is deterministic. `defaults`
    // stores a dictionary with its keys ordered, while an object literal in a
    // recipe carries insertion order; comparing the two as text would report
    // drift whenever a recipe listed keys in a different order, and rewrite the
    // key on every apply without ever converging. Array order is meaningful and
    // is left alone.
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const converted = traverse(entries, ([key, inner]) =>
      // `inner as PlistValue`: `isRecord` above narrows by *excluding* `object`
      // on its false branch, which is what lets this function's tail return
      // `boolean | number | string` — a guard narrowing to `PlistDict` instead
      // would leave `PlistArray`/`PlistData`/`PlistDate` in that tail even
      // though the branches above handle them, so `isRecord` earns its
      // `value is object` and `Object.entries` yields `unknown` values here.
      // oxlint-disable-next-line effect/noAs -- see the comment above.
      toNative(inner as PlistValue).pipe(Result.map((native) => entry(key, native))),
    );
    return Result.map(converted, (pairs) => Object.fromEntries(pairs));
  }

  return Result.succeed(value);
};

/** Converts parsed plist output back into the JSON-safe representation. */
const fromNative = (value: unknown): Result.Result<PlistValue, PlistDecodeError> => {
  if (value instanceof Uint8Array) return Result.succeed(data(Encoding.encodeBase64(value)));
  if (value instanceof Date) return Result.succeed(date(value.toISOString()));
  if (Array.isArray(value)) return traverse(value, fromNative);
  if (isRecord(value)) {
    const converted = traverse(Object.entries(value), ([key, inner]) =>
      fromNative(inner).pipe(Result.map((plist) => entry(key, plist))),
    );
    return Result.map(converted, (pairs) => Object.fromEntries(pairs));
  }
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return Result.succeed(value);
  }
  return Result.fail(
    new PlistDecodeError({ detail: `property lists cannot hold a ${typeof value}` }),
  );
};

/**
 * Serializes a value to an XML property list.
 *
 * XML is the only interchange format that can carry every property-list type.
 * JSON cannot represent `<data>`, and `plutil` refuses to emit JSON for any
 * document containing one — including when extracting an unrelated scalar key,
 * because it validates the whole document against the target format first.
 */
export const render = (value: PlistValue): Result.Result<string, PlistDecodeError> =>
  Result.map(toNative(value), (native) => build(native));

/** Reads an XML property list into the JSON-safe representation. */
export const readXml = (xml: string): Result.Result<PlistValue, PlistDecodeError> =>
  Result.flatMap(
    Result.try({
      try: () => parse(xml),
      catch: (cause) => new PlistDecodeError({ detail: "not a readable property list", cause }),
    }),
    fromNative,
  );

/**
 * Reduces XML from any source to one spelling, so two representations of the
 * same value compare equal.
 *
 * `plutil` and this serializer differ in indentation and attribute order, so
 * comparing their output as text reports drift that does not exist. Both sides
 * are parsed and re-serialized by the same writer before comparison.
 */
export const canonicalXml = (xml: string): Result.Result<string, PlistDecodeError> =>
  Result.flatMap(readXml(xml), render);
