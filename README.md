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
   | Deploy | Workers Scripts: **Edit**, D1: **Edit**, Workers R2 Storage: **Edit**, Turnstile: **Edit** | `CLOUDFLARE_API_TOKEN` (production environment) |
   | Plan (read-only) | Workers Scripts: **Read**, D1: **Read**, Workers R2 Storage: **Read**, Turnstile: **Read** | `PLAN_CLOUDFLARE_API_TOKEN` (repository) |

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
- **Repository variable:** `SITE_HOSTNAME` = the site's hostname, without `https://`:
  `club-booking.<subdomain>.workers.dev` (the subdomain you picked in step 1). Terraform
  limits the Turnstile check to this hostname, and the deploy's smoke test checks
  `https://<SITE_HOSTNAME>` after every deploy.
- **Ruleset:** once CI has run on a PR, add the required status checks `worker`, `infra`,
  `secrets` and `dependencies` to the `main` ruleset.

### 3. Secret keys (once, after the first deploy has created the Worker)

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

Then the Turnstile secret. Terraform creates the Turnstile widget. Copy its secret key from
the Cloudflare dashboard (**Turnstile → Club booking login → Settings**) and set it the same
way. Until it's set, logins still work, but while the club-wide alarm is on they'd be refused.

```bash
npx wrangler secret put TURNSTILE_SECRET   # paste the widget's secret key
```

Until `PEPPER`, `IP_HASH_KEY` and the throttle secrets are set, the live site refuses all
logins ("Login is temporarily unavailable"). That's on purpose.

## Running the club (admin how-tos)

Admin pages are at `/admin/`. Admins log in with a username, a password of at least 16
characters, and the 6-digit code from an authenticator app. Admin sessions last 12 hours.
Every admin action goes in the **Audit log** (kept 24 months, can't be edited).

### First-time admin setup (once per admin, up to the club's admin limit)

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
(it's never deleted, because old bookings point at it). Hours are club time (the club's time
zone), one box per day, like `09:00-12:00, 14:00-20:00`, on the quarter hour. An empty box means
closed. On a brand-new site with no courts or rooms yet, **Add the starting list** adds the
ones from the club's settings file, open its starting hours every day; change them from there.

### The club's settings (`clubs/pastime/club.json`)

Everything that differs from one club to the next is in one file: the club's name, intro
and contact text, its main website, time zone, admin limit, accent colors, booking limits,
the booking rules, and the starting list of courts and rooms with their starting hours.
Change it in a PR like any other code. The Worker reads it when it starts, and every page,
message and script gets its values from there.

- **Booking limits** (`booking`): the longest booking, upcoming bookings per member, days
  ahead, the cancel cutoff, the suggested suspension length, and the missed-bookings count
  in the rules. The database also enforces 2 hours and 2 upcoming bookings for every club,
  so a club can set those or less, never more.
- **Rules**: written once, with placeholders such as `{cancel_cutoff}` filled in from the
  limits, so the rules can never disagree with what the site enforces. They show on the
  Rules page and before every booking.
- **Admin limit** (`max_admins`): how many admins setup allows. Default 2; Pastime uses 1.
- **Colors**: only the accent and its text color, light and dark. The tests check WCAG AA
  contrast.
- **Starting list**: loaded once into an empty site (above). After that, the admin pages own
  courts, rooms and hours.

**Never put secrets in this file**, and never the throttle or alarm settings: the repo is
public. Only the settings listed above are allowed; anything else stops the Worker from
starting, and the tests fail. Pastime's address and contact details are placeholders until
the club confirms them, and there's no logo until the club gives permission.

To set the site up for another club, give it its own `clubs/<club>/club.json` and point the
one import in `worker/src/club.js` at it. Each club gets its own Cloudflare account,
database and secrets.

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

You can also **Turn alarm on now** (to test Turnstile, or if you see an attack starting) and
**Turn alarm off** after a false alarm. Both go in the audit log. **Before launch, test it
once on the live site:** turn it on, open the login page, check the Turnstile box appears
and you can log in, then turn it off.

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
  you want a fresh start.

### Test accounts (local only)

| Who | Log in with |
|---|---|
| Members | member numbers `1001` to `1005`; the PIN is the last digit six times (`1001` → `111111`, `1002` → `222222`, ...) |
| Admin | username `admin`, password `local-test-only-admin`, and the code from `npm run totp` |

These accounts can't work on the live site, even by mistake. Their PINs and password are
hashed with the fake pepper from `.dev.vars`, so they don't match under the real one.

The seed data also has the club's starting courts and rooms from its settings file (for
Pastime: the Gymnasium, President's Room, Century Room and Lounge, open 9 a.m. to 10 p.m.
every day), two league seasons in the gymnasium (Monday charity basketball, 6 to 8 p.m., and
a Tuesday basketball league, 7 to 9 p.m., for the next 3 months), a few bookings, so you can
see "Taken" slots, and two club events. Pastime's admin limit is 1 and the seed admin fills
it, so `/admin/setup` shows "closed" locally.

### Checks

```bash
npm test          # all tests, in the real Workers runtime against a local database
npm run typecheck # type check (// @ts-check + JSDoc)
npm run rules     # code rules: parameterized SQL, no innerHTML, no INSERT OR REPLACE, no club values in code
```

## Threat model

What we protect: members' bookings and PINs, the admin accounts, and the little personal data
we keep (member numbers, optional admin-only names, bookings, no-shows, suspensions). There
are no emails, phone numbers or payment details.

### Said plainly: a 6-digit PIN is weak on its own

A 6-digit PIN has only **1,000,000** possible values. If the database ever leaked, hashing
alone would not stop someone trying every PIN offline. Even at 100,000 rounds of PBKDF2 (the
most the Workers runtime allows), one modern graphics card can try all of them for a member
in seconds to minutes. **The pepper, kept outside the database, is what protects PINs in that
case.** Every PIN is mixed with a secret key (`PEPPER`) before hashing. That key is a Worker
secret, never in the database, the repo or Terraform state. Without it, a stolen database
gives an attacker nothing to start guessing with. If the pepper and the database leak
together, assume every PIN is known: set a new pepper and reissue every PIN.

Online, PINs are protected by throttling, so guessing through the website is slow and
noisy (see the table).

### Defences

| Threat | Main defences | What's left |
|---|---|---|
| Guessing one member's PIN online | 5 tries, then locks of 15 min / 1 h / 24 h; per-IP block; club-wide alarm | About 1,800 guesses a year at most: roughly a 0.2% chance per targeted member per year. |
| Trying one PIN across many members | Per-IP block (IPv6 counted per /64); club-wide alarm with configurable short- and long-window thresholds slows every login and requires Turnstile; admins see it on every page | An attacker who stays under the alarm's limits gets only that many guesses a day across the whole club. The limits set their odds, which is why their values are kept private. |
| Flooding the login to run up the bill | Flood gate (rate limiter) runs before any hashing; the Workers spending limit | |
| Locking a member out on purpose | Locks are timed, never permanent; an admin can clear one | **Accepted risk:** anyone who knows a member number can lock that member out for up to 24 hours. |
| Database copy leaks | Pepper (above); session tokens stored only as SHA-256; authenticator keys encrypted (AES-GCM, key from the pepper); IPs stored only as HMACs with a separate key, `IP_HASH_KEY` | See "Said plainly". If `IP_HASH_KEY` leaks with the database, the IPs behind the last 7 days of failed logins could be worked out; replace it. |
| Stolen member login | A member login can only see "Taken" slots, book or cancel that member's own bookings, and see their own no-show dates | The thief can act as that member until the PIN is reset (which logs them out everywhere). |
| Admin account takeover | Password of 16+ characters plus an authenticator code (each code works once); lockout; 12-hour sessions; every action in the audit log | A phished password plus a live code. Use a password manager, which won't fill in on a fake site. |
| Someone else's page making changes (CSRF) | Every change must come from our own Origin, be JSON, and carry the session's CSRF token; cookies are `SameSite=Strict` | |
| Script injection (XSS) | Strict Content Security Policy (only our own scripts, no inline code); pages build text with `textContent` only; CI fails on `innerHTML` and inline scripts | |
| Clickjacking | `frame-ancestors 'none'` and `X-Frame-Options: DENY` | |
| SQL injection | Every query uses `prepare(...).bind(...)`; CI fails on SQL built from strings | |
| Double booking | The database refuses it (one row per 15-minute slot, unique key, filled by a trigger), even if two members tap at once | |
| Bad dependency | No npm packages run in the live site; lockfile; Dependabot; actions pinned to commits; `npm audit` and dependency review in CI | Development tools in CI. |
| GitHub or Cloudflare account takeover | Two-factor login on both; required reviewer on the `production` environment; tightly scoped API tokens; a separate Cloudflare account for the club | |
| Members sharing PINs | The booking rules say not to | Can't be prevented technically. |

Out of scope: Cloudflare itself being compromised, and malware on a member's phone.

### Secrets: where they live

| Secret | Where | If lost | If leaked |
|---|---|---|---|
| `PEPPER` | Worker secret + both admins' password managers | Every PIN and admin password stops working: new pepper, reissue PINs, re-enrol admins | With the database: reissue every PIN |
| `IP_HASH_KEY` | Worker secret + both password managers | Set a new one; per-IP counts restart | With the database: replace it |
| `TURNSTILE_SECRET` | Worker secret (and Terraform state) | Copy it again from the dashboard | Rotate the widget's secret in the dashboard |
| Throttle settings | GitHub repository secrets, Terraform state | Choose new values | Choose new values |
| Cloudflare and R2 tokens | GitHub secrets | Make new ones | Revoke in Cloudflare at once |

Terraform state sits in a private R2 bucket that only the two scoped R2 tokens can read.

### Privacy and retention

The nightly job deletes bookings 12 months after they end, no-shows 12 months after their
date, suspensions 12 months after they end, leagues and events 12 months after they finish,
login failures after 7 days, and audit entries after 24 months. D1 Time Travel can still
restore deleted data for up to 30 days. No analytics, and no third-party scripts except
Turnstile while the alarm is on.

## How to book: a guide for members

*One page you can print or send to members. Replace the bracketed parts with the club's details.*

> ### Booking the court and rooms at [Club name]
>
> **You need:** your member number, and the 6-digit PIN the club gave you. Keep your PIN
> private; it's for you only.
>
> **1. Log in.** Go to **[site address]** and tap **Member login**. Type your member number
> and PIN, then tap **Log in**. You stay logged in on that phone or computer for 30 days.
>
> **2. Book.** Tap **Book**. Choose the court or room, then the day (up to 30 days ahead).
> Free times show **Free**; times someone else has booked show **Taken**. Tap the time you
> want to start, then choose how long (15 minutes up to 2 hours).
>
> **3. Agree to the rules.** Read the booking rules, tick **I agree**, and tap **Book it**.
>
> **4. Add it to your calendar.** Tap **Add to calendar** to get a reminder 1 hour before.
>
> **Good to know**
> - You can have up to **2 upcoming bookings** at a time.
> - **Cancelling:** go to **My bookings** and tap **Cancel booking**. You can cancel up to
>   **24 hours** before the start. After that, the booking can't be cancelled. If you can't
>   make it, please let management know.
> - **Missed bookings** are recorded by management. You can see yours under **My bookings**.
>   Members who miss 3 bookings may lose booking privileges for 6 months.
> - **Wrong PIN 5 times?** Your account locks for 15 minutes (then longer if it happens
>   again). Wait, or ask management to unlock it.
> - **Forgot your PIN?** Ask management for a new one.
> - **Club events** at other places are listed under **Club events**.
>
> Questions? Contact **[contact details]**.
