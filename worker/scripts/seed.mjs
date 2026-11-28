// @ts-check
// Resets the LOCAL database (worker/.wrangler) to known test data: 5 fake members, 1 test
// admin, the club's starting rooms and hours, two league seasons, a few bookings and events.
// It only ever runs wrangler with --local, and takes no options, so it can't be pointed at
// the live database.
//
// Usage (with `npm run dev` stopped): npm run seed
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { ensureDevVars } from "./dev-vars.mjs";
import { SEED_ADMIN, SEED_LEAGUES, SEED_MEMBERS, buildSeed, toSqlScript } from "./seed-data.js";

if (process.argv.length > 2) {
  console.error("npm run seed takes no options. It only ever writes to the local database.");
  process.exit(1);
}

const workerDir = new URL("..", import.meta.url);
const wrangler = new URL("../node_modules/.bin/wrangler", import.meta.url).pathname;
/** @param {string[]} args */
const run = (args) => execFileSync(wrangler, args, { cwd: workerDir, stdio: "inherit" });

const vars = ensureDevVars();
if (!vars.PEPPER) {
  console.error("worker/.dev.vars has no PEPPER. Copy it again from .dev.vars.example.");
  process.exit(1);
}

run(["d1", "migrations", "apply", "DB", "--local", "--force"]);

const statements = await buildSeed({ pepper: vars.PEPPER, now: Math.floor(Date.now() / 1000) });
mkdirSync(new URL("../.wrangler", import.meta.url), { recursive: true });
const file = new URL("../.wrangler/seed.sql", import.meta.url);
writeFileSync(file, toSqlScript(statements));
run(["d1", "execute", "DB", "--local", "--file", file.pathname]);

console.log("\nLocal test data is ready. Start the site with: npm run dev\n");
console.log("Members (member number / PIN):");
for (const m of SEED_MEMBERS) console.log(`  ${m.number} / ${m.pin}`);
console.log(`\nAdmin: username "${SEED_ADMIN.username}", password "${SEED_ADMIN.password}".`);
console.log(`Leagues: ${SEED_LEAGUES.map((l) => l.name).join(", ")}.`);
console.log("For the 6-digit code, run: npm run totp");
