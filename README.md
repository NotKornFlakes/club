# Club booking site

A simple, secure booking site for a private members club. Members log in with their member
number and a PIN, see which times are free, and book the court or a room. Admins manage
members, resources, leagues and no-shows.

It runs as one Cloudflare Worker with a D1 database, all set up by Terraform and deployed by
GitHub Actions. Design and reasoning: [docs/architecture.md](docs/architecture.md).

> **Status:** foundation only. The site serves a home page and the booking rules. Member
> login, booking and admin arrive in the next PRs.

## What's where

| Path | What it is |
|---|---|
| `worker/src/` | The Worker: plain JavaScript with `// @ts-check` and JSDoc types |
| `worker/public/` | Static pages and CSS |
| `worker/migrations/` | The D1 database schema, as numbered SQL files |
| `worker/test/` | Tests that run in the real Workers runtime against a local D1 |
| `worker/wrangler.json` | Worker settings, read by both wrangler and Terraform |
| `infra/` | Terraform: the Worker, D1, workers.dev address, nightly job |
| `.github/workflows/` | CI, deploy, weekly drift check |

## One-time setup

Done once, by the owner. Nothing here goes in the repo.

### 1. Cloudflare (the club's own account)

1. Create a new Cloudflare account for the club. Add the backup admin as a member. Turn on
   two-factor login for both.
2. **Workers & Pages:** open it once and pick the account's `workers.dev` subdomain. The site
   will be at `https://club-booking.<subdomain>.workers.dev`.
3. **Workers Paid plan** ($5/month). Logins need more CPU time than the free plan allows.
   The foundation works without it.
4. **R2:** turn it on, then create a bucket named **`club-tfstate`** for Terraform state. In
   the bucket's **Settings**, check that **Public Development URL** is **Disabled** and that
   there are no **Custom Domains**. Terraform keeps the r2.dev address off from then on.
5. **Cloudflare API tokens** (My Profile → API Tokens → Create Custom Token). Under
   **Account Resources**, include only the club account.

   | Token | Permissions (all "Account") | Goes in GitHub as |
   |---|---|---|
   | Deploy | Workers Scripts: **Edit**, D1: **Edit**, Workers R2 Storage: **Edit** | `CLOUDFLARE_API_TOKEN` (production environment) |
   | Plan (read-only) | Workers Scripts: **Read**, D1: **Read**, Workers R2 Storage: **Read** | `PLAN_CLOUDFLARE_API_TOKEN` (repository) |

6. **R2 API tokens** (R2 → Manage API tokens → Create API token). **Apply to specific
   buckets only** → `club-tfstate`. Each gives an Access Key ID and a Secret Access Key.

   | Token | Permission | Goes in GitHub as |
   |---|---|---|
   | Deploy | Object Read & Write | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (production environment) |
   | Plan | Object Read only | `PLAN_R2_ACCESS_KEY_ID`, `PLAN_R2_SECRET_ACCESS_KEY` (repository) |

### 2. GitHub (Settings → Secrets and variables → Actions)

- **Repository secrets:** `CLOUDFLARE_ACCOUNT_ID` (from the Cloudflare dashboard's account
  home), plus the three `PLAN_*` secrets above.
- **`production` environment secrets:** `CLOUDFLARE_API_TOKEN`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`. Only the approved deploy job on `main` can read these.
- **Repository variable:** `SITE_URL` = the workers.dev address, once the first deploy has
  created it. It turns on the post-deploy smoke test.
- **Ruleset:** once CI has run on a PR, add the required status checks `worker`, `infra`,
  `secrets` and `dependencies` to the `main` ruleset.

### 3. Secret keys (before the member-login PR)

Two Worker secrets, each 32 random bytes, set once by hand. They are never stored in the
repo, the database or Terraform state, and Terraform is told to leave them alone. **Both
admins save a copy of both in their password managers.** If `PEPPER` is lost, every PIN has
to be reissued.

```bash
cd worker
npx wrangler login              # opens the browser; log in to the club account
openssl rand -base64 32         # save the output in your password manager as PEPPER
npx wrangler secret put PEPPER  # paste it when asked
openssl rand -base64 32         # a different value: save it as IP_HASH_KEY
npx wrangler secret put IP_HASH_KEY
```

## How changes go live

1. A PR runs CI (tests, type check, code rules, Terraform checks, Checkov, zizmor, secret and
   dependency scans) and a read-only `terraform plan`.
2. The owner reviews and merges. Claude never merges or approves (see `CLAUDE.md`).
3. The deploy job waits for the owner's approval in the `production` environment, then:
   - creates the database if needed;
   - applies database migrations;
   - applies Terraform;
   - runs the smoke test.
4. Every Monday, the drift check compares the live setup with `main`.

Never run `wrangler deploy`. Terraform owns the Worker.

## Run it locally

You can try the whole site on your own computer. Nothing here talks to Cloudflare: the
database is a local file in `worker/.wrangler/`, and the secrets are made-up values.

**You need:** Node.js 24 or newer, and Firefox or Chrome (they allow the site's secure login
cookies on `http://localhost`; Safari doesn't).

```bash
cd worker
npm ci            # install the exact tool versions from package-lock.json
npm run seed      # reset the local database to test data (run it with the site stopped)
npm run dev       # the site at http://localhost:8787 (Ctrl+C to stop)
```

- `npm run dev` first creates `worker/.dev.vars` from
  [`worker/.dev.vars.example`](worker/.dev.vars.example) if it's missing, applies the
  database migrations to the local database, then starts the site.
- `.dev.vars` holds local settings only and is never committed. Never put real secrets in it
  or in the example file: the live site's values are set on Cloudflare and kept out of the repo.
- `npm run seed` wipes the local database and fills it with test data. Run it again any time
  you want a fresh start. It can only touch the local database: it refuses any option (such
  as `--remote`), refuses if `CLOUDFLARE_ENV` is set or `wrangler.json` doesn't point at the
  local placeholder database, and always runs wrangler with `--local`. Tests check this.

### Test accounts (local only)

| Who | Log in with |
|---|---|
| Members | member numbers `1001` to `1005`; the PIN is the last digit six times (`1001` → `111111`, `1002` → `222222`, ...) |
| Admin | username `admin`, password `local-test-only-admin`, and the code from `npm run totp` |

These accounts can't work on the live site, even by mistake. Their PINs and password are
hashed with the fake pepper from `.dev.vars`, so they don't match under the real one.

The seed data also has three resources (a court and two rooms) with opening hours, a few
bookings, so you can see "Taken" slots, and two club events.

### Checks

```bash
npm test          # all tests, in the real Workers runtime against a local database
npm run typecheck # type check (// @ts-check + JSDoc)
npm run rules     # code rules: parameterized SQL, no innerHTML, no INSERT OR REPLACE
```

## Threat model

The short version is in [docs/architecture.md, section 11](docs/architecture.md#11-threat-model-short-version-the-readme-gets-the-full-one).
The full one arrives here with the hardening PR. The key point, said plainly: a 6-digit PIN
has only 1,000,000 possible values, so if the database ever leaked, hashing alone would not
stop someone trying every PIN offline. The pepper, kept outside the database, is what
protects PINs in that case.
