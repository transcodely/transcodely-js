import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * One vitest run covers both workspace packages. The CLI imports the SDK by
 * its published name; the alias points that at the SDK's TypeScript source so
 * the tests never depend on a prior `pnpm build`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@transcodely/sdk": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "packages/*/tests/**/*.test.ts"],
  },
});
