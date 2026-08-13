import { planRecipe } from "./Commands.ts";
import { DEFAULT_DEADLINE_MILLIS, describeExit, runToExit } from "./Diagnostics.ts";

/**
 * `machine-run` — plans a recipe without going through `alchemy plan`.
 *
 * This exists because Alchemy's CLI cannot currently complete a plan for any
 * stack, including an empty one, and reports nothing at all when it fails:
 * exit 1, empty stdout, empty stderr, even at `--log-level all`. Two distinct
 * faults are behind that, both recorded in `docs/V2-PLAN.md`. One of them —
 * the layer ordering that makes `AlchemyContext` unavailable to the very
 * platform layer that needs it — this works around, in `Engine.ts`. The other
 * is not ours to fix.
 *
 * Whatever happens, this prints something and exits non-zero on failure. A
 * silent exit 0 on a total failure is the single worst behaviour a tool like
 * this can have, and it is the behaviour that made the underlying bug take so
 * long to find.
 *
 * Argument parsing is deliberately minimal rather than built on
 * `effect/unstable/cli` for now: this binary has one command, and the value it
 * adds is the diagnosis, not the flag grammar. Growing `deploy` and `destroy`
 * is when the parser earns its keep — see `packages/cli/TASKS.md`.
 */
const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? "plan";

  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(
      [
        "machine-run — reconcile this machine from a recipe",
        "",
        "  machine-run plan [recipe] [--stage <name>]",
        "",
        "  recipe   path to a recipe; defaults to ./alchemy.run.ts",
        "  --stage  deployment stage (default: dev)",
        "  --deadline-seconds  report a hang after this long (default: 600)",
        "",
      ].join("\n"),
    );
    return;
  }

  if (command !== "plan") {
    process.stderr.write(
      `Unknown command "${command}". Only \`plan\` exists so far — see packages/cli/TASKS.md.\n`,
    );
    process.exitCode = 2;
    return;
  }

  const positional = argv.slice(1).filter((argument) => !argument.startsWith("-"));
  const stageIndex = argv.indexOf("--stage");
  const stage = stageIndex === -1 ? "dev" : (argv[stageIndex + 1] ?? "dev");
  const deadlineIndex = argv.indexOf("--deadline-seconds");
  const deadlineMillis =
    deadlineIndex === -1
      ? DEFAULT_DEADLINE_MILLIS
      : Number(argv[deadlineIndex + 1] ?? "0") * 1000 || DEFAULT_DEADLINE_MILLIS;

  const exit = await runToExit(planRecipe({ recipe: positional[0], stage }), deadlineMillis);

  const described = describeExit(exit, (lines: readonly string[]) =>
    lines.length === 0 ? "No changes." : lines.join("\n"),
  );
  process.stdout.write(`${described.text}\n`);
  process.exitCode = described.code;
};

await main();
