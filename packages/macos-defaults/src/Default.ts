import { Sh } from "@machine-run/core";
import { type Reconciler, toProvider } from "@machine-run/engine";
import type { CommandError } from "alchemy/Command";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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
export const MacDefaultState = Schema.Struct({
  domain: Schema.String,
  key: Schema.String,
  xml: Schema.String,
});

export type MacDefaultState = typeof MacDefaultState.Type;

export interface MacDefault extends Resource<"MacOS.Default", MacDefaultProps, MacDefaultState> {}

export const MacDefault = Resource<MacDefault>("MacOS.Default");

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
  Reconciler<MacDefaultProps, MacDefaultState, PlistDecodeError | CommandError>
> = Effect.succeed({
  // `defaults` serialises per domain, and two keys in one domain are two
  // read-modify-write cycles over the same plist, so applies are serialised
  // per domain rather than per key.
  address: (props) => `defaults:${props.domain}`,

  /**
   * The live value of the key as canonical XML, or `undefined` when unset.
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
  observe: (props, ctx) =>
    ctx
      .exec({
        command: Sh.pipe(
          Sh.sh("defaults", "export", props.domain, "-"),
          Sh.sh("plutil", "-extract", props.key, "xml1", "-o", "-", "-"),
        ),
        shell: true,
      })
      .pipe(
        // A non-zero exit means the domain or the key is absent, which is an
        // ordinary state to converge from rather than a failure. `plutil`
        // exits 1 for a missing key path; `defaults export` of an unknown
        // domain succeeds with an empty dictionary, which then fails the
        // extract the same way.
        Effect.map((result) => result.stdout),
        Effect.orElseSucceed(() => undefined),
        Effect.flatMap((stdout) =>
          stdout === undefined
            ? Effect.succeed(undefined)
            : // Output that will not parse is a real failure rather than
              // "absent": `plutil` succeeded, so something is there, and
              // silently treating it as missing would overwrite a value
              // nobody could see.
              Effect.fromResult(canonicalXml(stdout)).pipe(
                Effect.map((xml) => ({ domain: props.domain, key: props.key, xml })),
              ),
        ),
      ),

  desired: (props) =>
    Effect.fromResult(render(props.value)).pipe(
      Effect.map((xml) => ({ domain: props.domain, key: props.key, xml })),
    ),

  matches: (observed, desired) =>
    observed.domain === desired.domain &&
    observed.key === desired.key &&
    observed.xml === desired.xml,

  apply: ({ props, desired }, ctx) =>
    Effect.gen(function* () {
      yield* ctx.exec({
        // Every fragment is quoted. Under `shell: true` an unquoted value
        // containing a space becomes several arguments, and one containing
        // `;` or `$(...)` becomes a second command — and an XML document is
        // full of characters a shell would otherwise interpret.
        command: Sh.sh("defaults", "write", props.domain, props.key, desired.xml),
        shell: true,
      });

      if (props.restartApp !== undefined) {
        yield* ctx
          .exec({ command: Sh.sh("killall", props.restartApp), shell: true })
          // `killall` exits non-zero when the app is not running, which is not
          // a failure to restart it.
          .pipe(Effect.catchTag("CommandError", () => Effect.void));
      }

      return desired;
    }),
});

export const MacDefaultProvider = () => toProvider(MacDefault, makeMacDefaultReconciler);
