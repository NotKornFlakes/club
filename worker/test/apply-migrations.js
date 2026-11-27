// @ts-check
// Runs before each test file: applies worker/migrations/*.sql to that file's local D1.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
