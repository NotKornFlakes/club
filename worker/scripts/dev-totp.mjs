// @ts-check
// npm run totp: prints the current 6-digit code for the LOCAL test admin, so you can log
// in to http://localhost:8787/admin/login without setting up an authenticator app.
import { SEED_ADMIN } from "./seed-data.js";
import { TOTP_PERIOD, base32Decode, totpCode, totpStep } from "../src/totp.js";

const secret = base32Decode(SEED_ADMIN.totpSecret);
if (!secret) throw new Error("Bad test secret");
const now = Math.floor(Date.now() / 1000);
const code = await totpCode(secret, totpStep(now));
console.log(`Code for "${SEED_ADMIN.username}": ${code}  (changes in ${TOTP_PERIOD - (now % TOTP_PERIOD)} s)`);
