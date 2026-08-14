import { Sh } from "@machine-run/core";
import { type Drift, type ObserveContext, type Reconciler, toProvider } from "@machine-run/engine";
import type { CommandError } from "alchemy/Command";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as UndefinedOr from "effect/UndefinedOr";
import { canonicalXml, PlistDecodeError, PlistValueSchema, render } from "./Value.ts";

export const MacDefaultProps = Schema.Struct({
  /** `defaults` domain, e.g. "com.apple.dock" or "NSGlobalDomain". */
  domain: Schema.String,
  key: Schema.String,
  /**
   * The desired value, in the JSON-safe property-list representation.
   * Booleans, numbers and strings are themselves; `<data>` and `<date>` use
   * the tagged wrappers from `./Value.ts`.
   */
  value: PlistValueSchema,
  /** App to `killall` after a real write so the change takes effect, e.g. "Dock". */
  restartApp: Schema.optionalKey(Schema.String),
});

export type MacDefaultProps = typeof MacDefaultProps.Type;

/**
 * One key in one `defaults` domain.
 *
 * The value is always written explicitly rather than only when it differs from
 * the factory default, so the result is reproducible on any machine rather
 * than dependent on what that machine happened to start with.
 *
 * Reads and writes both go through XML property lists rather than `defaults`'
 * own scalar flags. The scalar flags cannot express an array, dictionary or
 * data value at all, and `defaults`' shorthand list syntax silently coerces:
 * writing `(alpha, 3)` stores `3` as a string, so the value read back never
 * matches the value written and the key is rewritten on every apply.
 */
/**
 * The value is carried as canonical XML so two spellings of the same
 * property-list value compare equal — see `canonicalXml`.
 */
/**
 * What was at this key before the apply that last changed it.
 *
 * Tagged rather than an optional string because "the key held no value" and "we
 * never captured one" are different facts and `unapply` must act differently
 * on them: the first means delete the key, the second means do nothing. An
 * optional `previousXml` would collapse them into the same absent field.
 */
export const MacDefaultPrevious = Schema.TaggedUnion({
  /** The key did not exist before this resource wrote it. */
  Absent: {},
  /** The key held this value, as canonical XML. */
  Value: { xml: Schema.String },
});

export type MacDefaultPrevious = typeof MacDefaultPrevious.Type;

export const MacDefaultState = Schema.Struct({
  domain: Schema.String,
  key: Schema.String,
  xml: Schema.String,
  /**
   * Captured by `apply` so `unapply` can restore rather than guess.
   *
   * `apply` receives the live value as `observed`, so capturing it costs
   * nothing. It is absent only on state written before this field existed;
   * that legacy state is deliberately left alone by `unapply`.
   */
  previous: Schema.optionalKey(MacDefaultPrevious),
});

export type MacDefaultState = typeof MacDefaultState.Type;

export interface MacDefault extends Resource<"MacOS.Default", MacDefaultProps, MacDefaultState> {}

export const MacDefault = Resource<MacDefault>("MacOS.Default");

/**
 * `defaults write` exited successfully, but a fresh property-list read still
 * disagrees with the requested canonical XML. This is a typed failure rather
 * than a returned desired state so the persisted output cannot claim a write
 * that the preferences system did not make visible.
 */
export class MacDefaultNotConverged extends Data.TaggedError("MacDefaultNotConverged")<{
  domain: string;
  key: string;
  expected: string;
  actual: string | undefined;
}> {
  override get message() {
    const actual = this.actual === undefined ? "absent" : `"${this.actual}"`;
    return `macOS default ${this.domain}/${this.key} was written, but a fresh read returned ${actual} instead of the requested value.`;
  }
}

/**
 * The missing-key shape is the only non-zero result observe may classify as
 * absence. A command-not-found, permission failure, broken preferences
 * daemon, or any other non-zero result must remain a typed command error.
 * This wording was captured from the real macOS pipeline:
 * `plutil -extract missing xml1 -o - -`.
 */
const MISSING_VALUE =
  /Could not extract value, error: No value at that key path or invalid key path:/;

const isMissingValue = (error: CommandError): boolean =>
  error.reason._tag === "UnexpectedExit" &&
  error.reason.exitCode === 1 &&
  MISSING_VALUE.test(error.reason.stderr);

const observeMacDefault = (props: MacDefaultProps, ctx: ObserveContext) =>
  ctx
    .exec({
      command: Sh.pipe(
        Sh.sh("defaults", "export", props.domain, "-"),
        Sh.sh("plutil", "-extract", props.key, "xml1", "-o", "-", "-"),
      ),
      shell: true,
    })
    .pipe(
      // Only plutil's captured missing-value diagnostic means the domain or
      // key is absent. A different command failure is unreadable state, not
      // absence, and must not cause an invisible overwrite.
      Effect.map((result) => Option.some(result.stdout)),
      Effect.catchTag("CommandError", (error) =>
        isMissingValue(error) ? Effect.succeed(Option.none<string>()) : Effect.fail(error),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none()),
          // Output that will not parse is a real failure rather than
          // "absent": `plutil` succeeded, so something is there, and
          // silently treating it as missing would overwrite a value
          // nobody could see.
          onSome: (stdout) =>
            Effect.fromResult(canonicalXml(stdout)).pipe(
              Effect.map((xml) => Option.some({ domain: props.domain, key: props.key, xml })),
            ),
        }),
      ),
    );

/**
 * `CommandError` is in the error union rather than being converted to a defect,
 * which is what `apply` used to do. A `defaults write` fails for ordinary
 * reasons — a domain needing privileges this run does not have, a container
 * without a real preferences daemon, a sandboxed app's container being
 * unwritable — and dying on those made one unwritable key abort the whole run
 * instead of failing one resource, unrecoverably, since nothing can catch a
 * defect. Two other reconcilers (`Dotfiles.Exec`, `Shell.Login`) already carry
 * `CommandError` in `E`, so this was a choice rather than something the seam
 * forced.
 */
export const makeMacDefaultReconciler: Effect.Effect<
  Reconciler<
    MacDefaultProps,
    MacDefaultState,
    PlistDecodeError | CommandError | MacDefaultNotConverged
  >
> = Effect.succeed({
  // `defaults` serialises per domain, and two keys in one domain are two
  // read-modify-write cycles over the same plist, so applies are serialised
  // per domain rather than per key.
  address: (props) => `defaults:${props.domain}`,

  /**
   * The live value of the key as canonical XML, or `Option.none()` when unset.
   *
   * These keys are routinely written by things other than this tool — System
   * Settings, an OS update, another script — so a recorded value cannot stand
   * in for the live one.
   *
   * The domain is exported and the single key extracted from it, rather than
   * read directly, because `defaults read` prints the old-style plist format,
   * which is ambiguous: it quotes strings only when necessary and has no
   * distinct spelling for data or dates.
   */
  observe: observeMacDefault,

  desired: (props) =>
    Effect.fromResult(render(props.value)).pipe(
      Effect.map((xml) => ({ domain: props.domain, key: props.key, xml })),
    ),

  matches: (observed, desired) =>
    observed.domain === desired.domain &&
    observed.key === desired.key &&
    observed.xml === desired.xml,

  // A property-list value has no ordering — two spellings of the same value
  // already compare equal via `canonicalXml`, so a real difference here is
  // just "different", never "ahead" or "behind".
  drift: (observed, desired): Drift => {
    const fields = [
      ...(observed.domain !== desired.domain
        ? [{ field: "domain", observed: observed.domain, desired: desired.domain }]
        : []),
      ...(observed.key !== desired.key
        ? [{ field: "key", observed: observed.key, desired: desired.key }]
        : []),
      ...(observed.xml !== desired.xml
        ? [{ field: "value", observed: observed.xml, desired: desired.xml }]
        : []),
    ];
    return fields;
  },

  /**
   * Restores the live value captured immediately before this resource's write.
   * Old state written before `previous` existed has no safe prior value,
   * so `unapply` deliberately does nothing for that state rather than
   * deleting or guessing.
   */
  apply: ({ props, observed, desired }, ctx) =>
    Effect.gen(function* () {
      yield* ctx.exec({
        // Every fragment is quoted. Under `shell: true` an unquoted value
        // containing a space becomes several arguments, and one containing
        // `;` or `$(...)` becomes a second command — and an XML document is
        // full of characters a shell would otherwise interpret.
        command: Sh.sh("defaults", "write", props.domain, props.key, desired.xml),
        shell: true,
      });

      // A successful `defaults write` is not proof that the preferences
      // system committed the value. Read it through the same canonical path
      // used during planning before returning persisted state.
      const confirmed = yield* observeMacDefault(props, ctx);
      const actual = Option.match(confirmed, {
        onNone: () => undefined,
        onSome: (state) => state.xml,
      });
      if (actual !== desired.xml) {
        return yield* Effect.fail(
          new MacDefaultNotConverged({
            domain: props.domain,
            key: props.key,
            expected: desired.xml,
            actual,
          }),
        );
      }

      if (props.restartApp !== undefined) {
        yield* ctx
          .exec({ command: Sh.sh("killall", props.restartApp), shell: true })
          // `killall` exits non-zero when the app is not running, which is not
          // a failure to restart it.
          .pipe(Effect.catchTag("CommandError", () => Effect.void));
      }

      // Captured from `observed`, which is the live value read immediately
      // before the write above — so this is what was actually there, not what a
      // previous run recorded.
      return {
        ...desired,
        previous: Option.match(observed, {
          onNone: (): MacDefaultPrevious => ({ _tag: "Absent" }),
          onSome: (state): MacDefaultPrevious => ({ _tag: "Value", xml: state.xml }),
        }),
      };
    }),

  /**
   * Restores the value this resource overwrote, or removes the key when it wrote
   * one that had not existed.
   *
   * Honest because `apply` captures the live value rather than assuming one: a key
   * that was absent is deleted, a key that held something gets that something
   * back. State written before `previous` existed carries no capture, and this
   * does nothing rather than guessing — `defaults delete` on a key the operator
   * set themselves would be the worst available outcome.
   */
  unapply: ({ recorded }, ctx) =>
    UndefinedOr.match(recorded.previous, {
      onUndefined: () => Effect.void,
      onDefined: (previous) =>
        Match.value(previous).pipe(
          Match.tagsExhaustive({
            Absent: () =>
              ctx
                .exec({
                  command: Sh.sh("defaults", "delete", recorded.domain, recorded.key),
                  shell: true,
                })
                .pipe(Effect.asVoid),
            Value: ({ xml }) =>
              ctx
                .exec({
                  command: Sh.sh("defaults", "write", recorded.domain, recorded.key, xml),
                  shell: true,
                })
                .pipe(Effect.asVoid),
          }),
        ),
    }),
});

export const MacDefaultProvider = () => toProvider(MacDefault, makeMacDefaultReconciler);
