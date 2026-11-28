// @ts-check
// Reads worker/.dev.vars (local secrets for wrangler dev). If it doesn't exist yet,
// creates it from .dev.vars.example, which holds made-up values only.
import { copyFileSync, existsSync, readFileSync } from "node:fs";

const DEV_VARS = new URL("../.dev.vars", import.meta.url);
const EXAMPLE = new URL("../.dev.vars.example", import.meta.url);

/** @returns {Record<string, string>} */
export function ensureDevVars() {
  if (!existsSync(DEV_VARS)) {
    copyFileSync(EXAMPLE, DEV_VARS);
    console.log("Created worker/.dev.vars from .dev.vars.example (made-up local values).");
  }
  /** @type {Record<string, string>} */
  const vars = {};
  for (const line of readFileSync(DEV_VARS, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || !m[1]) continue;
    let value = m[2] ?? "";
    if (/^'.*'$/.test(value) || /^".*"$/.test(value)) value = value.slice(1, -1);
    vars[m[1]] = value;
  }
  return vars;
}
