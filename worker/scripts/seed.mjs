// @ts-check
// Resets the LOCAL database (worker/.wrangler) to known test data: 5 fake members, 1 test
// admin, resources, hours, a few bookings and events.
//
// It can't reach the live database: seedCommands() (scripts/seed-data.js, tested in
// test/seed.test.js) refuses any option, CLOUDFLARE_ENV, or a wrangler.json that isn't the
// local placeholder, and builds the only two wrangler commands, both with --local.
// Nothing here runs before those checks pass.
//
// Usage (with `npm run dev` stopped): npm run seed
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ensureDevVars } from "./dev-vars.mjs";
import { SEED_ADMIN, SEED_MEMBERS, buildSeed, seedCommands, toSqlScript } from "./seed-data.js";

const workerDir = new URL("..", import.meta.url);
const wrangler = new URL("../node_modules/.bin/wrangler", import.meta.url).pathname;
const file = new URL("../.wrangler/seed.sql", import.meta.url);
const config = JSON.parse(readFileSync(new URL("../wrangler.json", import.meta.url), "utf8"));

/** @type {[string[], string[]]} */
let commands;
try {
  commands = seedCommands(process.argv.slice(2), config, file.pathname, process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const [migrate, load] = commands;

/** @param {string[]} args */
const run = (args) => execFileSync(wrangler, args, { cwd: workerDir, stdio: "inherit" });

const vars = ensureDevVars();
if (!vars.PEPPER) {
  console.error("worker/.dev.vars has no PEPPER. Copy it again from .dev.vars.example.");
  process.exit(1);
}

run(migrate);

const statements = await buildSeed({ pepper: vars.PEPPER, now: Math.floor(Date.now() / 1000) });
mkdirSync(new URL("../.wrangler", import.meta.url), { recursive: true });
writeFileSync(file, toSqlScript(statements));
run(load);

console.log("\nLocal test data is ready. Start the site with: npm run dev\n");
console.log("Members (member number / PIN):");
for (const m of SEED_MEMBERS) console.log(`  ${m.number} / ${m.pin}`);
console.log(`\nAdmin: username "${SEED_ADMIN.username}", password "${SEED_ADMIN.password}".`);
console.log("For the 6-digit code, run: npm run totp");
