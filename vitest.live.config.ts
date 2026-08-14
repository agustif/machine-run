import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "packages/**/test/**/*.live.test.ts",
      "packages/dotfiles/test/Exec.test.ts",
      "packages/ssh/test/Key.test.ts",
      "packages/git/test/Identity.test.ts",
    ],
  },
});
