import { MachinePathsLive } from "@machine-run/core";
import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import {
  makeTemplateReconciler,
  renderTemplate,
  TemplateRenderFailed,
  type TemplateProps,
} from "../src/Template.ts";

const layer = Layer.mergeAll(MachinePathsLive(), NodeCrypto.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const applyCtx = {
  exec: () => Effect.die("not used"),
  snapshot: () => Effect.succeed(undefined),
};
const observeCtx = { exec: () => Effect.die("not used") };

/**
 * `renderTemplate` in isolation: pure and total, so no filesystem or `Effect`
 * runtime is needed to pin down the substitution rule itself.
 */
it("substitutes every ${name} with its matching variable", () => {
  const result = renderTemplate("Host ${host}\nUser ${user}", { host: "example.com", user: "a" });
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isSuccess(result)) {
    expect(result.success).toBe("Host example.com\nUser a");
  }
});

it("fails, naming the placeholder, when a ${name} has no matching variable", () => {
  const result = renderTemplate("Host ${host}", {});
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure.missing).toEqual(["host"]);
  }
});

it("names every distinct missing placeholder, deduplicated and sorted", () => {
  const result = renderTemplate("${b} ${a} ${b} ${c}", {});
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure.missing).toEqual(["a", "b", "c"]);
  }
});

it("does not fail on a variable the template never references", () => {
  // An unused value cannot corrupt the output the way a missing one can, and
  // recipes commonly share one `variables` record across several templates.
  const result = renderTemplate("static text", { unused: "x" });
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isSuccess(result)) expect(result.success).toBe("static text");
});

it("does not re-expand a placeholder-shaped value: one substitution pass, not a recursive one", () => {
  // If a *value* happens to contain `${...}` text, expanding it again would
  // make the output depend on substitution order — this must not happen.
  const result = renderTemplate("${a}", { a: "${b}", b: "should never appear" });
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isSuccess(result)) expect(result.success).toBe("${b}");
});

it("a value can supply the literal placeholder text as its own escape hatch", () => {
  // The documented workaround for content that must contain literal
  // `${SOMETHING}` text unexpanded: name it as a variable whose value is
  // that literal string.
  const result = renderTemplate("export HOME=${HOME}", { HOME: "${HOME}" });
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isSuccess(result)) expect(result.success).toBe("export HOME=${HOME}");
});

it.effect("apply renders variables into the file's content", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeTemplateReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "config");

    const props: TemplateProps = {
      path: target,
      template: "host = ${host}\nport = ${port}",
      variables: { host: "example.com", port: "22" },
    };
    const desired = yield* reconciler.desired(props);
    yield* reconciler.apply({ props, observed: Option.none(), desired }, applyCtx);

    expect(yield* fs.readFileString(target)).toBe("host = example.com\nport = 22");
  }).pipe(Effect.provide(layer)),
);

it.effect("a changed variable is detected as drift on the next plan", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeTemplateReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "config");

    const props: TemplateProps = {
      path: target,
      template: "host = ${host}",
      variables: { host: "example.com" },
    };
    const desired = yield* reconciler.desired(props);
    yield* reconciler.apply({ props, observed: Option.none(), desired }, applyCtx);

    // Nothing hand-edited the file — only the recipe's `variables` changed.
    const changedProps: TemplateProps = { ...props, variables: { host: "changed.example" } };
    const observed = yield* reconciler.observe(changedProps, observeCtx);
    const newDesired = yield* reconciler.desired(changedProps);

    expect(Option.isSome(observed)).toBe(true);
    expect(reconciler.matches(Option.getOrThrow(observed), newDesired)).toBe(false);
  }).pipe(Effect.provide(layer)),
);

it.effect("a hand-edit to the rendered file is detected as drift, same as Machine.File", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeTemplateReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "config");

    const props: TemplateProps = {
      path: target,
      template: "host = ${host}",
      variables: { host: "example.com" },
    };
    const desired = yield* reconciler.desired(props);
    yield* reconciler.apply({ props, observed: Option.none(), desired }, applyCtx);

    yield* fs.writeFileString(target, "hand-edited, not what the recipe asked for");

    const observed = yield* reconciler.observe(props, observeCtx);
    expect(reconciler.matches(Option.getOrThrow(observed), desired)).toBe(false);
  }).pipe(Effect.provide(layer)),
);

/**
 * The guard this resource exists to add over `Machine.File`: a template that
 * references a variable nobody supplied must fail loudly, at plan time,
 * rather than writing `${missing}` to disk looking like ordinary text.
 */
it.effect("desired fails with TemplateRenderFailed before ever touching the filesystem", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const reconciler = yield* makeTemplateReconciler;

    const props: TemplateProps = {
      path: path.join("/nonexistent", "config"),
      template: "host = ${host}",
      variables: {},
    };
    const error = yield* reconciler.desired(props).pipe(Effect.flip);
    expect(error).toBeInstanceOf(TemplateRenderFailed);
    if (error instanceof TemplateRenderFailed) {
      expect(error.missing).toEqual(["host"]);
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("apply also fails with TemplateRenderFailed rather than writing a broken file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeTemplateReconciler;
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "config");

    const props: TemplateProps = { path: target, template: "host = ${host}", variables: {} };
    // `desired` would already fail for these props; `apply` is exercised
    // directly with a hand-built desired state to confirm it independently
    // refuses rather than assuming `desired` was always called first.
    const error = yield* reconciler
      .apply(
        { props, observed: Option.none(), desired: { path: target, hash: "irrelevant" } },
        applyCtx,
      )
      .pipe(Effect.flip);
    expect(error).toBeInstanceOf(TemplateRenderFailed);
    expect(yield* fs.exists(target)).toBe(false);
  }).pipe(Effect.provide(layer)),
);

/**
 * `Template` delegates `drift`/`unapply` straight to `File`'s own reconciler
 * — a rendered template is, from the filesystem's point of view, exactly a
 * file. This just confirms the delegation is wired up.
 */
it.effect("drift is empty exactly when matches is true, delegated from File", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeTemplateReconciler;
    const drift = reconciler.drift;
    if (drift === undefined) return yield* Effect.die("expected drift to be defined");
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "config");

    const props: TemplateProps = {
      path: target,
      template: "host = ${host}",
      variables: { host: "example.com" },
    };
    const desired = yield* reconciler.desired(props);
    yield* reconciler.apply({ props, observed: Option.none(), desired }, applyCtx);
    const observed = Option.getOrThrow(yield* reconciler.observe(props, observeCtx));

    expect(reconciler.matches(observed, desired)).toBe(true);
    expect(drift(observed, desired)).toEqual([]);

    const changedProps: TemplateProps = { ...props, variables: { host: "changed.example" } };
    const newDesired = yield* reconciler.desired(changedProps);
    expect(reconciler.matches(observed, newDesired)).toBe(false);
    expect(drift(observed, newDesired).map((f) => f.field)).toEqual(["content"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("unapply restores the file it overwrote, delegated from File", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconciler = yield* makeTemplateReconciler;
    const unapply = reconciler.unapply;
    if (unapply === undefined) return yield* Effect.die("expected unapply to be defined");
    const dir = yield* fs.makeTempDirectoryScoped();
    const target = path.join(dir, "config");

    yield* fs.writeFileString(target, "hand-written before machine-run");

    const props: TemplateProps = {
      path: target,
      template: "host = ${host}",
      variables: { host: "example.com" },
    };
    const desired = yield* reconciler.desired(props);
    const observedBefore = yield* reconciler.observe(props, observeCtx);
    const snapshottingCtx = {
      exec: () => Effect.die("not used"),
      snapshot: (t: string) =>
        fs.copy(t, `${t}.bak`).pipe(
          Effect.as(`${t}.bak`),
          Effect.orElseSucceed(() => undefined),
        ),
    };
    // The engine captures the backup and passes the path in — see
    // `ApplyInput.snapshot`.
    const archived = `${target}.bak`;
    yield* fs.copy(target, archived);
    const output = yield* reconciler.apply(
      { props, observed: observedBefore, desired, snapshot: archived },
      snapshottingCtx,
    );
    expect(yield* fs.readFileString(target)).toBe("host = example.com");

    const observedNow = Option.getOrThrow(yield* reconciler.observe(props, observeCtx));
    yield* unapply({ props, observed: observedNow, recorded: output }, snapshottingCtx);

    expect(yield* fs.readFileString(target)).toBe("hand-written before machine-run");
  }).pipe(Effect.provide(layer)),
);
