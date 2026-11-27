// @ts-check
// Prints wrangler.json with the live D1 database ID filled in, for
// `wrangler d1 migrations apply --remote` in the deploy job. The real ID comes
// from Terraform output, so it never has to be committed.
//
// Usage: node scripts/remote-wrangler-config.mjs <database-id> > wrangler.remote.json
import { readFileSync } from "node:fs";

const id = process.argv[2] ?? "";
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
  console.error("Expected a D1 database ID (UUID) as the only argument.");
  process.exit(1);
}

const config = JSON.parse(readFileSync(new URL("../wrangler.json", import.meta.url), "utf8"));
config.d1_databases[0].database_id = id;
process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
