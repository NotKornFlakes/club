// @ts-check
// Tests run inside the real Workers runtime (workerd) with a local D1 database.
// Every test file gets its own fresh database with the migrations applied.
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.json" },
      miniflare: {
        // Test-only binding: the migration files, applied by test/apply-migrations.js
        bindings: { TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")) },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.js"],
  },
});
