// @ts-check
// Tests run inside the real Workers runtime (workerd) with a local D1 database.
// Every test file gets its own fresh database with the migrations applied.
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * Made-up values for tests only. The live site's values are different and private.
 * The throttle limits are small so tests can reach them quickly.
 */
export const TEST_BINDINGS = {
  PEPPER: "test-pepper-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  IP_HASH_KEY: "test-ip-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  THROTTLE_SETTINGS: JSON.stringify({
    ip_failures_per_hour: 8,
    alarm_short_minutes: 10,
    alarm_short_failures: 12,
    alarm_long_failures: 20,
    alarm_hold_minutes: 30,
    alarm_delay_ms: 1,
  }),
  TURNSTILE_SITE_KEY: "test-site-key",
  TURNSTILE_SECRET: "test-turnstile-secret",
  ADMIN_SETUP_TOKEN: "test-setup-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.json" },
      miniflare: {
        bindings: {
          ...TEST_BINDINGS,
          // Test-only binding: the migration files, applied by test/apply-migrations.js
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.js"],
  },
});
