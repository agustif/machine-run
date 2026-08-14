import { defineConfig } from "vitest/config";

// oxlint-disable-next-line effect/noGlobals -- the test runner boundary supplies the sandbox-specific cache directory through the process environment.
const cacheDir = process.env.MACHINE_RUN_VITEST_CACHE_DIR ?? "node_modules/.vite";

export default defineConfig({
  // The hermetic runner supplies a writable temp directory. Keeping the
  // normal default preserves the conventional local Vitest cache while the
  // restricted container can keep the checkout completely read-only.
  cacheDir,
  test: {
    environment: "node",
    include: ["packages/**/test/**/*.test.ts"],
    exclude: [
      "**/*.live.test.ts",
      // These legacy-named files intentionally exercise host boundaries. Their
      // hermetic parser/reconciler coverage lives in sibling tests without a
      // real shell, ssh-keygen, or /bin/sh dependency.
      "packages/dotfiles/test/Exec.test.ts",
      "packages/ssh/test/Key.test.ts",
      "packages/git/test/Identity.test.ts",
    ],
  },
});
