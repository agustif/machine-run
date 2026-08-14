import { MachinePaths, Platform } from "@machine-run/core";
import { type Reconciler, toProvider } from "@machine-run/engine";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Crypto from "effect/Crypto";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { PlatformError } from "effect/PlatformError";
import {
  type FileProps,
  type FileState,
  type FilePathUnreadable,
  makeFileReconciler,
} from "./File.ts";

/**
 * `${name}` substitution over `Record<string, string>`, and nothing else.
 *
 * This is deliberately the smallest possible templating language rather than
 * a real one:
 *
 * - It is **total**: every input string maps to exactly one output for a
 *   given `variables`, with no partial-evaluation states, no conditionals, no
 *   loops, and therefore nothing in the template language itself that can be
 *   "wrong" independent of the variables supplied. A real templating engine
 *   (Handlebars, EJS, a Mustache implementation) buys expressiveness at the
 *   cost of its own escaping rules, its own control flow, and — for most of
 *   them — a `require` this repo does not need.
 * - `${name}` is one substitution pass, not a recursive one: the regex runs
 *   once over `template` and each match is replaced with the literal string
 *   in `variables`, so a *value* that happens to contain `${anotherName}`
 *   text is emitted verbatim rather than expanded again. Recursive expansion
 *   would make the output depend on the *order* names are substituted in,
 *   which is exactly the kind of surprise "smallest thing that is total"
 *   rules out.
 * - There is no escape sequence for a literal `${...}` that isn't meant as a
 *   placeholder. Adding one (`$${` for a literal `${`, say) is itself a
 *   surprising rule someone has to learn and every reader of a rendered file
 *   has to know about to explain a stray `$`. If a template's *literal*
 *   output must contain `${SOMETHING}` text — a generated shell script that
 *   itself uses `${HOME}` syntax, say — the workaround is to name that text
 *   as a variable whose value is the literal string
 *   (`variables: { HOME: "${HOME}" }`), which uses the one substitution rule
 *   that already exists rather than adding a second one. A template that
 *   needs this often is a sign {@link File} (with the content built by hand)
 *   or {@link ManagedBlock} is the better fit — this resource exists for the
 *   common case of interpolating a handful of values into otherwise-static
 *   content, not for generating shell scripts about shell scripts.
 *
 * ## Unknown and missing placeholders both fail
 *
 * A `${name}` in `template` with no matching key in `variables` fails render
 * rather than being left as literal `${name}` text in the output. Leaving it
 * behind is how a broken config reaches disk looking fine — the file exists,
 * has plausible-looking content, and the failure only surfaces later, as
 * whatever tool reads `${name}` literally (a shell trying to run it, a
 * parser choking on it) rather than as a clear error at `plan`/`apply` time
 * naming exactly which placeholder was never given a value. `variables`
 * carrying an extra key nothing in `template` references is not an error: an
 * unused value cannot corrupt the output the way a missing one can, and
 * recipes commonly share one `variables` record across several templates
 * that each use a different subset of it.
 */
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Raised when `template` references a `${name}` with no matching key in
 * `variables`.
 */
export class TemplateRenderFailed extends Data.TaggedError("TemplateRenderFailed")<{
  path: string;
  missing: ReadonlyArray<string>;
}> {
  override get message() {
    return `Template for "${this.path}" references \${${this.missing.join("}, ${")}}, which "variables" does not provide a value for. Every \${name} placeholder needs a matching entry, or the rendered file would silently carry the literal placeholder text.`;
  }
}

/**
 * Substitutes every `${name}` in `template` with `variables[name]`.
 *
 * Pure and total: given the same `template` and `variables`, this always
 * produces the same {@link Result}, so it is unit-testable without a
 * filesystem or an `Effect` runtime — the same shape as {@link renderFile}.
 */
export const renderTemplate = (
  template: string,
  variables: Record<string, string>,
): Result.Result<string, { missing: ReadonlyArray<string> }> => {
  const missing = new Set<string>();
  const rendered = template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = variables[name];
    if (value === undefined) {
      missing.add(name);
      return whole;
    }
    return value;
  });
  if (missing.size > 0) return Result.fail({ missing: Array.from(missing).sort() });
  return Result.succeed(rendered);
};

/**
 * A {@link File} whose content is rendered from `template` and `variables`
 * rather than supplied pre-built — see this module's doc comment for the
 * templating rules. Everything else about ownership is identical to `File`:
 * the rendered result is the file's entire content, and anything else
 * written there is replaced on the next apply.
 *
 * `variables` is a prop, so — like `File.content` — it is persisted into
 * Alchemy's state store as unencrypted JSON. Nothing credential-shaped
 * belongs in it; use `@machine-run/secrets`' `Machine.SecretFile` for that,
 * the same rule `File`'s doc comment states for `content`.
 */
export const TemplateProps = Schema.Struct({
  /** Path to the file. `~` is expanded. */
  path: Schema.String,
  /** Template source. Every `${name}` in it must have a matching key in `variables`. */
  template: Schema.String,
  /** Values substituted into `template`. An entry `template` never references is not an error. */
  variables: Schema.Record(Schema.String, Schema.String),
  /** POSIX file mode, e.g. `0o600`. Left alone when unset. */
  mode: Schema.optionalKey(Schema.Number),
  /** POSIX mode for directories created to hold this file, e.g. `0o700`. */
  directoryMode: Schema.optionalKey(Schema.Number),
});

export type TemplateProps = typeof TemplateProps.Type;

/**
 * Reuses {@link FileState} verbatim: a rendered template is, from the
 * filesystem's point of view, exactly a file with a content hash and a mode —
 * `observe` hashes what is actually on disk, and `desired` hashes the
 * *rendered* result, so an edit to `variables` that changes the rendered
 * output is real drift, detected the same way a hand-edit to a plain
 * `Machine.File` is.
 */
export const TemplateState = Schema.Struct({
  path: Schema.String,
  hash: Schema.String,
  mode: Schema.optionalKey(Schema.Number),
  backupPath: Schema.optionalKey(Schema.String),
});

export type TemplateState = typeof TemplateState.Type;

export interface Template extends Resource<"Machine.Template", TemplateProps, TemplateState> {}

export const Template = Resource<Template>("Machine.Template");

/**
 * Renders `props` into the {@link FileProps} `makeFileReconciler` expects, or
 * fails with {@link TemplateRenderFailed}.
 *
 * Shared by `desired` and `apply` so both fail identically on a bad template,
 * rather than one silently tolerating what the other rejects.
 */
const toFileProps = (props: TemplateProps): Effect.Effect<FileProps, TemplateRenderFailed> => {
  const rendered = renderTemplate(props.template, props.variables);
  if (Result.isFailure(rendered)) {
    return Effect.fail(
      new TemplateRenderFailed({ path: props.path, missing: rendered.failure.missing }),
    );
  }
  return Effect.succeed({
    path: props.path,
    content: rendered.success,
    ...(props.mode !== undefined ? { mode: props.mode } : {}),
    ...(props.directoryMode !== undefined ? { directoryMode: props.directoryMode } : {}),
  });
};

/**
 * Delegates every real filesystem concern to {@link makeFileReconciler}: this
 * reconciler's entire job is turning `TemplateProps` into the `FileProps` a
 * plain file reconciler already knows how to observe, hash and write.
 * `address` and `observe` never need to render at all — `File`'s own
 * `content` prop is ignored by both — so only `desired` and `apply` can ever
 * raise {@link TemplateRenderFailed}, and a plan surfaces a render failure
 * before ever touching the filesystem, since `desired` runs during planning.
 */
export const makeTemplateReconciler: Effect.Effect<
  Reconciler<
    TemplateProps,
    TemplateState,
    PlatformError | FilePathUnreadable | TemplateRenderFailed
  >,
  never,
  FileSystem.FileSystem | Path.Path | MachinePaths | Crypto.Crypto | Platform
> = Effect.gen(function* () {
  const file: Reconciler<FileProps, FileState, PlatformError | FilePathUnreadable> =
    yield* makeFileReconciler;
  const fileUnapply = file.unapply;

  return {
    address: (props) => file.address({ path: props.path, content: "" }),
    snapshotBeforeApply: true,
    // same as File, which it delegates to.
    refuseUnowned: true,

    observe: (props, ctx) => file.observe({ path: props.path, content: "" }, ctx),

    desired: (props) =>
      Effect.gen(function* () {
        const fileProps = yield* toFileProps(props);
        return yield* file.desired(fileProps);
      }),

    matches: file.matches,
    drift: file.drift,

    // Spread rather than rebuilt field by field, so anything `ApplyInput` gains
    // later — `snapshot` was the first — reaches `File` without this needing an
    // edit. Rebuilding it is how the backup path went missing once already.
    apply: (input, ctx) =>
      Effect.gen(function* () {
        const fileProps = yield* toFileProps(input.props);
        return yield* file.apply({ ...input, props: fileProps }, ctx);
      }),

    // Delegates verbatim, like everything else here: a rendered template is,
    // from the filesystem's point of view, exactly a `File`, so restoring or
    // removing it is the same operation. `content: ""` is a stand-in `File`
    // never reads here — its `unapply` only looks at `observed`/`recorded`,
    // the same reason `address`/`observe` above pass one too.
    unapply:
      fileUnapply === undefined
        ? undefined
        : ({ props, observed, recorded }, ctx) =>
            fileUnapply({ props: { path: props.path, content: "" }, observed, recorded }, ctx),
  };
});

export const TemplateProvider = () => toProvider(Template, makeTemplateReconciler);
