import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.getuid?.() === 0) {
  // oxlint-disable-next-line effect/noGlobals -- this is the process-level entrypoint guard for a test runner, not application code.
  console.error("hermetic tests must run without elevated privileges");
  // oxlint-disable-next-line effect/noGlobals -- this is the process-level entrypoint guard for a test runner, not application code.
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), "machine-run-hermetic-"));
const home = join(root, "home");
const temp = join(root, "tmp");
const config = join(home, ".config");
const cache = join(home, ".cache");
const data = join(home, ".local", "share");
const state = join(home, ".local", "state");
mkdirSync(config, { recursive: true });
mkdirSync(cache, { recursive: true });
mkdirSync(data, { recursive: true });
mkdirSync(state, { recursive: true });
mkdirSync(temp);

const networkGuard = resolve(project, "scripts/forbid-network.mjs");
const nodeDirectory = dirname(process.execPath);
// oxlint-disable-next-line effect/noGlobals -- the runner must scrub inherited host configuration before spawning the test process.
const inheritedEnv = Object.fromEntries(
  // oxlint-disable-next-line effect/noGlobals -- reading the parent environment is the boundary this runner is isolating.
  Object.entries(process.env).filter(([name]) => {
    const lowerName = name.toLowerCase();
    return (
      name !== "NODE_OPTIONS" &&
      !name.startsWith("MACHINE_RUN_") &&
      !lowerName.startsWith("npm_config_") &&
      name !== "SSH_AUTH_SOCK"
    );
  }),
);

const env = {
  ...inheritedEnv,
  HOME: home,
  USERPROFILE: home,
  TMPDIR: temp,
  TMP: temp,
  TEMP: temp,
  XDG_CONFIG_HOME: config,
  XDG_CACHE_HOME: cache,
  XDG_DATA_HOME: data,
  XDG_STATE_HOME: state,
  PATH: nodeDirectory,
  NODE_OPTIONS: `--import=${networkGuard}`,
  CI: "1",
  LANG: "C",
  LC_ALL: "C",
  TZ: "UTC",
  NO_COLOR: "1",
};

const vitest = resolve(project, "node_modules/vitest/vitest.mjs");
let status = 1;
// oxlint-disable-next-line effect/noTryCatch -- the child process must always release its temporary root, including spawn failures.
try {
  const result = spawnSync(process.execPath, [vitest, "run"], {
    cwd: project,
    env,
    stdio: "inherit",
  });
  status = result.status ?? 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
// oxlint-disable-next-line effect/noGlobals -- this is the runner's process-level exit status.
process.exit(status);
