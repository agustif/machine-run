import { expect, it } from "@effect/vitest";
import * as Fs from "node:fs";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Exec } from "@machine-run/engine";
import { makeDnfBackend } from "../src/backends/linux/Dnf.ts";
import { makePacmanBackend } from "../src/backends/linux/Pacman.ts";

const envPath = (name: string): Option.Option<string> =>
  Effect.runSync(Config.option(Config.string(name)));

const dnfListing = envPath("MACHINE_RUN_DNF_LIST");
const pacmanListing = envPath("MACHINE_RUN_PACMAN_LIST");

const execOutput =
  (stdout: string): Exec =>
  (_props) =>
    Effect.succeed({ exitCode: 0, stdout, stderr: "" });

/**
 * The Linux verification job captures output from Fedora and Arch containers,
 * then feeds those exact bytes through the production backend parsers. The
 * fixture tests pin known quirks; this catches a CLI format change in the
 * images CI actually uses without pretending Ubuntu's host tools are dnf or
 * pacman.
 */
it.effect.skipIf(Option.isNone(dnfListing))("dnf output still parses", () =>
  Effect.gen(function* () {
    const entries = yield* makeDnfBackend().list(
      execOutput(Fs.readFileSync(Option.getOrThrow(dnfListing), "utf8")),
    );
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.name.length > 0)).toBe(true);
  }),
);

it.effect.skipIf(Option.isNone(pacmanListing))("pacman output still parses", () =>
  Effect.gen(function* () {
    const entries = yield* makePacmanBackend().list(
      execOutput(Fs.readFileSync(Option.getOrThrow(pacmanListing), "utf8")),
    );
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.name.length > 0)).toBe(true);
    expect(entries.every((entry) => entry.version !== undefined)).toBe(true);
  }),
);
