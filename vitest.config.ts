import { defineConfig } from "vitest/config";

export default defineConfig({
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
