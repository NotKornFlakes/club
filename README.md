# Club booking site

A simple, secure booking site for a private members club. Members log in with their member
number and a PIN, see which times are free, and book the court or a room. Admins manage
members, resources, leagues and no-shows.

It runs as one Cloudflare Worker with a D1 database, all set up by Terraform and deployed by
GitHub Actions. Design and reasoning: [docs/architecture.md](docs/architecture.md).

> **Status:** member login, booking, no-shows and suspensions, and admin are built and run
> locally (see "Run it locally"). Hardening, then the club's own domain, come next.

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
- **Login throttle secrets (repository secrets):** pick your own values and keep them
  private. Never write them in the repo, an issue, a PR or a commit message. Save a copy in
  your password manager.
  - `LOGIN_FLOOD_LIMIT`: logins allowed per IP per 60 seconds before requests are dropped
    (one whole number).
  - `THROTTLE_SETTINGS`: one line of JSON with exactly these keys, each a positive whole
    number: `ip_failures_per_hour`, `alarm_short_minutes`, `alarm_short_failures`,
    `alarm_long_failures` (per 24 hours), `alarm_hold_minutes`, `alarm_delay_ms`.

  They're repository secrets, not `production` ones, so PR plans, the weekly drift check and
  deploys all use the same values. Terraform marks them sensitive, so plan output in the
  public Actions logs shows `(sensitive value)`, never the numbers. If either is missing or
  malformed, the live site refuses logins ("Login is temporarily unavailable") rather than
  guessing. The values in `worker/.dev.vars.example` and `worker/wrangler.json` are made-up
  local ones; don't reuse them.
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

## Running the club (admin how-tos)

Admin pages are at `/admin/`. Admins log in with a username, a password of at least 16
characters, and the 6-digit code from an authenticator app. Admin sessions last 12 hours.
Every admin action goes in the **Audit log** (kept 24 months, can't be edited).

### First-time admin setup (once per admin, at most two)

1. Make a long random setup token and set it as a Worker secret:
   `openssl rand -base64 32`, then `cd worker && npx wrangler secret put ADMIN_SETUP_TOKEN`.
2. Open `/admin/setup`, enter the token, and add the key it shows to your authenticator app
   (type it in, or tap the link on your phone). Choose a username and password (save it in
   your password manager) and enter the current code.
3. Repeat for the backup admin, then delete the token: `npx wrangler secret delete ADMIN_SETUP_TOKEN`.
   Setup is closed from then on.

If one admin loses their password or authenticator, the other opens **Dashboard → Admins →
Reset login** and gives them the new temporary password and key in person or by phone. If
both are lost, set a new setup token and repeat setup.

### Issuing PINs

- **One member:** **Members → Add a member** (member number, optional name only admins see).
- **Many members:** **Members → Import members from a CSV file**. One member per line,
  `member number,name` (the name is optional; a header line is fine). Existing numbers are
  skipped. The page sends 25 at a time.
- Either way, the new PINs appear **once** on the **New PINs** sheet. **Print it before you
  leave the page.** PINs are stored only as salted, peppered hashes, so nobody, including you,
  can look one up later. If the page closes first, reset those members' PINs.

### Resetting a PIN (forgotten PIN)

**Members → find the member → Open → Reset PIN.** The old PIN stops working, the member is
logged out everywhere, any lockout is cleared, and the new PIN appears on the PIN sheet to
print.

### Lockouts

After 5 wrong PINs, an account locks for 15 minutes, then 1 hour, then 24 hours. A right PIN
or 7 days without failures resets it. To unlock early: **Members → Open → Clear lockout**.

### Recording a no-show and suspending a member

- **Members → Open → Record a no-show**: the date, and an optional note (only admins see it).
  Members see their own no-show dates for the last 12 months. No-shows are deleted after
  12 months. Remove one only if it was recorded by mistake.
- **Suspend from booking**: pick the last day (default 6 months from today) and give a reason
  (required). This cancels the member's upcoming bookings, frees the slots, and logs each
  cancelled booking. The member can still log in and look, and sees "Your booking access is
  suspended until [date]. Contact management." To lift it early: **Lift suspension now**.

### Courts, rooms and hours

**Courts & rooms**: add, rename, set the order, or untick "Members can book it" to retire one
(it's never deleted, because old bookings point at it). Hours are club time (New York), one box
per day, like `09:00-12:00, 14:00-20:00`, on the quarter hour. An empty box means closed.

### Admin bookings, leagues and events

- **Schedule**: pick a court or room and a date to see who booked each slot. **Add an admin
  booking** for closures or one-off events: no date limit, member rules don't apply, up to
  30 days per booking. **Cancel this booking** works on any booking, even within 24 hours.
  The member isn't told automatically, so let them know.
- **Leagues**: one season = one court or room, one weekday, a start and end time, and a
  first and last date (at most 12 months from today). Every free date is booked; dates that
  clash with an existing booking are skipped and listed with who has them. When a season
  ends, use **Renew season** to create the next one. **Cancel league** frees its future
  dates. For two weekdays, create two leagues.
- **Club events**: events at other places, shown to members on their Club events page.

### The login alarm

If failed logins across the club spike, the alarm switches on by itself. While it's on, every
login is slowed, the login pages ask for a Cloudflare Turnstile check, and every admin page
shows a red banner. The **Dashboard** shows its status, recent failed-login counts, and when
it went on before. It switches off by itself after a while. The limits are private settings
(see setup step 2).

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
