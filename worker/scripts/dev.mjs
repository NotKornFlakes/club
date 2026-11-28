// @ts-check
// npm run dev: applies the database migrations to the local database, then starts
// wrangler dev at http://localhost:8787. Local only; nothing here reaches Cloudflare.
import { execFileSync, spawn } from "node:child_process";
import { ensureDevVars } from "./dev-vars.mjs";

const workerDir = new URL("..", import.meta.url);
const wrangler = new URL("../node_modules/.bin/wrangler", import.meta.url).pathname;

ensureDevVars();
execFileSync(wrangler, ["d1", "migrations", "apply", "DB", "--local", "--force"], { cwd: workerDir, stdio: "inherit" });

const dev = spawn(wrangler, ["dev", "--local", "--port", "8787", ...process.argv.slice(2)], {
  cwd: workerDir,
  stdio: "inherit",
});
dev.on("exit", (code) => process.exit(code ?? 0));
for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
  process.on(signal, () => dev.kill(signal));
}
